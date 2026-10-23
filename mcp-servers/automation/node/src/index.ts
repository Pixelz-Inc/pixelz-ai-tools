import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { jsonSchemaValidator, JsonSchemaValidatorResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Node's built-in .env loader (stable since 22.21). Like dotenv it never overrides variables
// that are already set, and unlike dotenv it prints nothing to stdout (which carries JSON).
// A missing file is fine: the credentials may come from the environment instead.
const ENV_FILE = process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../../.env');
if (fs.statSync(ENV_FILE, { throwIfNoEntry: false })?.isFile()) process.loadEnvFile(ENV_FILE);

const AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = 'https://automation-api.pixelz.com/v1';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_RETRIES = 3;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
// Same methods urllib3 retries by default, so Node matches the Python sibling. POST is excluded:
// it creates billable jobs, and a 502/504 can arrive after the backend already accepted one.
const RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

// Socket-level failures worth another attempt on an idempotent request. undici (behind fetch)
// reports a peer that closed the connection as UND_ERR_SOCKET and a stalled connect as
// UND_ERR_CONNECT_TIMEOUT, where axios used ECONNRESET / ETIMEDOUT.
const RETRY_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
// Same ceiling as the Python sibling's Retry(retry_after_max=...): a huge Retry-After must not
// park a CLI run or an MCP tool call for hours.
const RETRY_AFTER_MAX_SECONDS = 60;

// HTTP via Node's built-in fetch, shaped like the slice of axios this file used to rely on:
// JSON in/out, a timeout, errors carrying .response / .code, and retries.
class UploadFile {
    constructor(readonly path: string) {}
}

type RequestOptions = { params?: Record<string, any>; body?: any; headers?: Record<string, string>; timeout?: number };

/** The OS error code behind a failed fetch, e.g. ECONNREFUSED; ECONNABORTED for our timeout. */
function networkCode(err: any): string | undefined {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'ECONNABORTED';
    // fetch reports socket failures as TypeError('fetch failed') with the code on .cause, or on
    // .cause.errors[] when every address refused (seen on Windows for ECONNREFUSED).
    return err.cause?.code ?? err.cause?.errors?.find((e: any) => e.code)?.code;
}

async function backoff(attempt: number, retryAfter: string | null) {
    // Retry-After may be empty or an HTTP-date rather than seconds; those fall back to backoff.
    const secs = retryAfter == null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
    const delay = Number.isFinite(secs)
        ? Math.min(Math.max(secs, 0), RETRY_AFTER_MAX_SECONDS) * 1000
        : Math.min(1000 * 2 ** attempt, 30000);
    await new Promise(r => setTimeout(r, delay));
}

async function request(method: string, url: string, { params, body, headers = {}, timeout = REQUEST_TIMEOUT }: RequestOptions = {}): Promise<{ status: number; data: any }> {
    if (params) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(filterNullParams(params));
    for (let attempt = 0; ; attempt++) {
        const retryable = RETRY_METHODS.has(method) && attempt < MAX_RETRIES;
        const h: Record<string, string> = { ...headers };
        let payload: any = body;
        if (body instanceof UploadFile) {
            // A Blob backed by the file: streamed from disk with the Content-Length S3 requires (a
            // stream body would go out chunked), and safe to send again on a retry.
            payload = await fs.openAsBlob(body.path);
        } else if (body !== undefined && !(body instanceof URLSearchParams)) {
            payload = JSON.stringify(body);
            h['Content-Type'] = h['Content-Type'] || 'application/json';
        }
        let res: Response, text: string;
        try {
            res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout) });
            // Inside the try and under the same signal: a stall mid-body is a timeout too.
            text = await res.text();
        } catch (e: any) {
            const code = networkCode(e);
            if (retryable && code && RETRY_CODES.has(code)) { await backoff(attempt, null); continue; }
            const timedOut = !!code && TIMEOUT_CODES.has(code);
            // Deliberately no URL in the message: Platform credentials travel in the query string.
            throw Object.assign(new Error(code ? `${e.message} (${code})` : e.message),
                { code: timedOut ? 'ECONNABORTED' : code, network: !timedOut && code !== 'ERR_INVALID_URL' });
        }
        let data: any = text, isJson = true;
        try { data = text ? JSON.parse(text) : ''; } catch { isJson = false; }
        if (res.ok) {
            // A 2xx that is not JSON is a proxy or login page, not an API answer (Python fails too).
            if (!isJson) throw new Error(`[API_ERROR] Expected a JSON response (HTTP ${res.status}), got: ${redactSecrets(text).slice(0, 100)}`);
            return { status: res.status, data };
        }
        if (retryable && RETRY_STATUS.has(res.status)) {
            await backoff(attempt, res.headers.get('retry-after'));
            continue;
        }
        throw Object.assign(new Error(`Request failed with status code ${res.status}`), { response: { status: res.status, data } });
    }
}

function filterNullParams(obj: Record<string, any>): Record<string, string> {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null).map(([k, v]) => [k, String(v)]));
}

const http = {
    get: (url: string, opts: RequestOptions = {}) => request('GET', url, opts),
    post: (url: string, body: any, opts: RequestOptions = {}) => request('POST', url, { ...opts, body }),
    put: (url: string, body: any, opts: RequestOptions = {}) => request('PUT', url, { ...opts, body }),
    delete: (url: string, opts: RequestOptions = {}) => request('DELETE', url, opts),
};

// fetch's timeout covers the whole request, where axios's was socket inactivity, so an upload's
// limit must include the transfer itself. 32 KB/s (~256 kbit/s) keeps slow uplinks working.
const uploadTimeout = (size: number) => REQUEST_TIMEOUT + Math.ceil(size / (32 * 1024)) * 1000;

function redactSecrets(text: string): string {
    let s = text;
    for (const key of ['PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET']) {
        const val = process.env[key];
        if (!val) continue;
        // Match raw AND percent-encoded forms: a credential echoed back inside a URL
        // appears encoded, where a literal match would silently miss it.
        // URLSearchParams (our query strings) encodes !'()~ and spaces differently from encodeURIComponent.
        for (const variant of new Set([val, encodeURIComponent(val), encodeURI(val), new URLSearchParams({ v: val }).toString().slice(2)])) {
            s = s.replaceAll(variant, '<REDACTED>');
        }
    }
    // Backstop by param name, so an encoding the variants above miss still cannot leak.
    s = s.replace(/(client_id|client_secret)=[^&\s'"]*/gi, '$1=<REDACTED>');
    return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>');
}

const logFile = process.env.PIXELZ_LOG_FILE;
function log(level: string, message: string, data?: any) {
    if (!logFile) return;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    // Redacted here, not at call sites: error text can carry a credentialed request URL.
    fs.appendFile(logFile, redactSecrets(entry), (err) => { if (err) process.stderr.write('Log write failed: ' + err.message + '\n'); });
}

function validateId(value: string, name: string) {
    if (!/^[a-zA-Z0-9_\-]+$/.test(value)) {
        throw new Error(`Invalid ${name}: contains unexpected characters`);
    }
}

const tokenCache = { token: null as string | null, expiresAt: 0 };
let tokenPromise: Promise<string> | null = null;

async function getAccessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }
    if (!tokenPromise) {
        tokenPromise = (async () => {
            try {
                const clientId = process.env.PIXELZ_AUTOMATION_CLIENT_ID;
                const clientSecret = process.env.PIXELZ_AUTOMATION_CLIENT_SECRET;
                if (!clientId || !clientSecret) throw new Error("[AUTH_ERROR] Missing PIXELZ_AUTOMATION_CLIENT_ID or PIXELZ_AUTOMATION_CLIENT_SECRET in .env");
                const params = new URLSearchParams();
                params.append('grant_type', 'client_credentials');
                params.append('client_id', clientId);
                params.append('client_secret', clientSecret);
                log('info', 'Requesting new OAuth token');
                const response = await http.post(AUTH_URL, params, { timeout: REQUEST_TIMEOUT });
                tokenCache.token = response.data.access_token;
                tokenCache.expiresAt = Date.now() + ((response.data.expires_in || 3600) - 60) * 1000;
                return tokenCache.token!;
            } finally {
                tokenPromise = null;
            }
        })();
    }
    return tokenPromise;
}

const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp'
};

async function ensureUrlOrId(input: string, token: string) {
    if (!input) return null;
    if (input.startsWith('http://') || input.startsWith('https://')) return input;
    if (!fs.existsSync(input)) throw new Error(`Local file not found: ${input}`);
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Not a regular file: ${input}`);
    const fileSize = fs.statSync(resolved).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const fileName = path.basename(resolved);
    log('info', 'Requesting upload URL', { fileName });
    const presignRes = await http.post(`${BASE_URL}/files/request-upload-url`, { fileName }, { headers: { 'Authorization': `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
    const uploadUrl = presignRes.data.url;
    const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    log('info', 'Uploading file', { fileName, size: fileSize });
    await http.put(uploadUrl, new UploadFile(resolved), { headers: { 'Content-Type': contentType }, timeout: uploadTimeout(fileSize) });
    return uploadUrl;
}

const TOOLS = [
            {
                name: "remove_background",
                description: "AI-powered background removal. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. featherWidth softens edges (0–1=sharp, >1=soft). Pass trimapUrl from create_trimap for complex edges. Only set sync=true if the user explicitly requests synchronous processing (risk of timeout).",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        backgroundColor: { type: "string", description: "Hex color for replacement background (e.g. #FFFFFF). Mutually exclusive with transparentBackground." },
                        transparentBackground: { type: "boolean", description: "Return a transparent PNG. Defaults to true if backgroundColor is not set." },
                        featherWidth: { type: "number", description: "Soften subject edges. 0–1 = sharp, >1 = soft." },
                        trimapUrl: { type: "string", description: "URL of a trimap for improved edge quality. Generate one first with create_trimap." },
                        callbackUrl: { type: "string", description: "Webhook URL to receive result notification." },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it — may time out on large images." }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "color_matching",
                description: "AI-powered color correction. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. Only set sync=true if the user explicitly requests it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        colorMarkers: {
                            type: "array",
                            description: "Array of marker objects. Each requires x_coordinate, y_coordinate, and either swatch_color_code (hex) or swatch_image (object with swatch_image_url, x_coordinate, y_coordinate).",
                            items: { type: "object" }
                        },
                        callbackUrl: { type: "string" },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it." }
                    },
                    required: ["imagePath", "colorMarkers"]
                }
            },
            {
                name: "create_mask",
                description: "Generate a greyscale silhouette mask (white=subject, black=background). Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. Only set sync=true if the user explicitly requests it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        featherWidth: { type: "number", description: "Soften mask edges. 0–1 = sharp, >1 = soft." },
                        trimapUrl: { type: "string", description: "URL of a trimap for improved accuracy on complex edges." },
                        callbackUrl: { type: "string" },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it." }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "create_trimap",
                description: "Generate a trimap for complex subjects (hair, fur, transparent edges). Default: async — returns job_id. Pass result trimapUrl to remove_background or create_mask for higher quality edges. Only set sync=true if the user explicitly requests it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        callbackUrl: { type: "string" },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it." }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "model_crop",
                description: "Crop a model photograph using anatomical landmarks. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. Locations: eye_higher, below_eye, btw_eye_and_nose, below_nose, between_nose_and_mouth, below_mouth, below_chin, chest, at_elbow_higher, at_elbow_lower, waist, below_buttock, main_body_axis, mid_thigh, above_knee, at_knee, below_knee. Only set sync=true if the user explicitly requests it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        topCropLocation: { type: "string", enum: ["eye_higher", "below_eye", "btw_eye_and_nose", "below_nose", "between_nose_and_mouth", "below_mouth", "below_chin", "chest", "at_elbow_higher", "at_elbow_lower", "waist", "below_buttock", "main_body_axis", "mid_thigh", "above_knee", "at_knee", "below_knee"] },
                        bottomCropLocation: { type: "string", enum: ["eye_higher", "below_eye", "btw_eye_and_nose", "below_nose", "between_nose_and_mouth", "below_mouth", "below_chin", "chest", "at_elbow_higher", "at_elbow_lower", "waist", "below_buttock", "main_body_axis", "mid_thigh", "above_knee", "at_knee", "below_knee"] },
                        callbackUrl: { type: "string" },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it." }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "get_job_status",
                description: "Check the status of any async Automation job. Most jobs finish in 30–60 seconds; large images can take several minutes. Call this once per check — never loop on it, since you cannot wait out an interval mid-turn. Read status.status_name: Created/ReadyForProcess/Processing = still working, report status and check again later; Completed or Delivered = result.result_image_url is ready; Failed = report the error to the user and ask whether to resubmit.",
                inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }
            },
            {
                name: "get_webhook_public_key",
                description: "Retrieve the ECDSA public key used to verify Pixelz Automation webhook payload signatures. Store this key in your application to validate incoming webhook requests.",
                inputSchema: { type: "object", properties: {} }
            },
] as const;

// --- Zod validation schemas ---
const CROP_LOCATIONS = ["eye_higher", "below_eye", "btw_eye_and_nose", "below_nose",
    "between_nose_and_mouth", "below_mouth", "below_chin", "chest",
    "at_elbow_higher", "at_elbow_lower", "waist", "below_buttock",
    "main_body_axis", "mid_thigh", "above_knee", "at_knee", "below_knee"] as const;

const RemoveBgSchema = z.object({
    imagePath: z.string().min(1),
    backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #FFFFFF').optional(),
    transparentBackground: z.boolean().optional(),
    featherWidth: z.number().min(0).optional(),
    trimapUrl: z.string().optional(),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const ColorMatchingSchema = z.object({
    imagePath: z.string().min(1),
    colorMarkers: z.array(z.object({}).passthrough()).min(1),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const CreateMaskSchema = z.object({
    imagePath: z.string().min(1),
    featherWidth: z.number().min(0).optional(),
    trimapUrl: z.string().optional(),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const CreateTrimapSchema = z.object({
    imagePath: z.string().min(1),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const ModelCropSchema = z.object({
    imagePath: z.string().min(1),
    topCropLocation: z.enum(CROP_LOCATIONS).optional(),
    bottomCropLocation: z.enum(CROP_LOCATIONS).optional(),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const JobIdSchema = z.object({ jobId: z.string().min(1) });

async function callTool(name: string, args: any) {
    try {
        // Inside the try: getAccessToken() throws on missing credentials or a failed token
        // exchange, and callers are promised a structured error result rather than a
        // protocol-level throw.
        const token = await getAccessToken();
        let response;
        log('info', `Tool called: ${name}`, args);

        const filterNull = (obj: Record<string, any>) => Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));

        const makeHeaders = (sync: boolean) => {
            const h: Record<string, string> = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
            if (!sync) h['Respond-Mode'] = 'async';
            return h;
        };

        switch (name) {
            case "remove_background": {
                const p = RemoveBgSchema.parse(args);
                // The API takes exactly one of the two ("do not set both, and do not leave both unset"),
                // so transparency defaults to the opposite of whether a color was given.
                const transparent = p.transparentBackground ?? !p.backgroundColor;
                if (p.backgroundColor && transparent) throw new Error('[VALIDATION_ERROR] backgroundColor and transparentBackground=true cannot be used together');
                if (!p.backgroundColor && !transparent) throw new Error('[VALIDATION_ERROR] transparentBackground=false requires backgroundColor: set backgroundColor, or leave transparentBackground unset/true');
                const rbUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/remove-background`, filterNull({
                    image_url: rbUrl,
                    background_color: p.backgroundColor || undefined,
                    transparent_background: transparent,
                    feather_width: p.featherWidth,
                    trimap_url: p.trimapUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "color_matching": {
                const p = ColorMatchingSchema.parse(args);
                const cmUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/color-matching`, filterNull({
                    image_url: cmUrl,
                    color_markers: p.colorMarkers,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "create_mask": {
                const p = CreateMaskSchema.parse(args);
                const mUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/create-mask`, filterNull({
                    image_url: mUrl,
                    feather_width: p.featherWidth,
                    trimap_url: p.trimapUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "create_trimap": {
                const p = CreateTrimapSchema.parse(args);
                const tUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/create-trimap`, filterNull({
                    image_url: tUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "model_crop": {
                const p = ModelCropSchema.parse(args);
                const mcUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/model-crop`, filterNull({
                    image_url: mcUrl,
                    top_crop_location: p.topCropLocation,
                    bottom_crop_location: p.bottomCropLocation,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_job_status": {
                const p = JobIdSchema.parse(args);
                validateId(p.jobId, 'jobId');
                const h: Record<string, string> = { 'Authorization': `Bearer ${token}` };
                response = await http.get(`${BASE_URL}/images/jobs/${p.jobId}/status`, { headers: h, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_webhook_public_key": {
                const h: Record<string, string> = { 'Authorization': `Bearer ${token}` };
                response = await http.get(`${BASE_URL}/webhook/public-keys`, { headers: h, timeout: REQUEST_TIMEOUT });
                break;
            }
            default:
                throw new Error("Unknown tool");
        }
        log('info', `Tool ${name} succeeded`);
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error: any) {
        let errorMsg: string;
        if (error instanceof z.ZodError) {
            // zod 4 renamed ZodError.errors -> .issues
            errorMsg = `[VALIDATION_ERROR] ${error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`;
        } else if (error.response) {
            const status = error.response.status;
            const data = error.response.data;
            errorMsg = `[HTTP_${status}] ${typeof data === 'object' ? JSON.stringify(data) : data}`;
        } else if (error.code === 'ECONNABORTED') {
            errorMsg = `[TIMEOUT] Request timed out after ${REQUEST_TIMEOUT / 1000} seconds`;
        } else if (error.network) {
            errorMsg = `[NETWORK_ERROR] ${error.message}`;
        } else {
            errorMsg = error.message;
        }
        errorMsg = redactSecrets(errorMsg);
        log('error', `Tool ${name} failed`, { error: errorMsg });
        return { content: [{ type: "text", text: `Error: ${errorMsg}` }], isError: true };
    }
}

// Defer all argument validation to the Zod schemas in callTool rather than letting the SDK's
// AJV pass reject first. Zod is the stricter of the two (hex-colour regex, enum and range
// bounds the advertised JSON Schema doesn't fully express) and it produces this project's
// documented `[VALIDATION_ERROR] field: reason` contract, which the skills tell users to expect.
const passThroughValidator: jsonSchemaValidator = {
    getValidator: <T,>() => (input: unknown): JsonSchemaValidatorResult<T> =>
        ({ valid: true, data: input as T, errorMessage: undefined })
};

// One factory call per connection; serveStdio pins the instance for its lifetime.
function buildServer() {
    const server = new McpServer(
        { name: "pixelz-automation-mcp", version: "2.0.0" },
        {
            capabilities: { tools: {} },
            // The tool list is a static array — a real TTL lets clients skip re-fetching
            // and improves LLM prompt-cache hits (SEP-2549). It carries no per-account
            // data, so shared intermediaries may cache it.
            cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "public" } }
        }
    );
    for (const tool of TOOLS) {
        server.registerTool(
            tool.name,
            { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema, passThroughValidator) },
            async (args: any) => callTool(tool.name, args) as any
        );
    }
    return server;
}

export { buildServer, callTool, TOOLS, getAccessToken, ensureUrlOrId, validateId, redactSecrets,
    CROP_LOCATIONS, RemoveBgSchema, ModelCropSchema, ColorMatchingSchema, JobIdSchema };

if (process.env.NODE_ENV !== 'test') {
    // legacy: 'serve' (the default) keeps pre-2026 clients working through the
    // initialize handshake, so older agent CLIs are unaffected by the v2 upgrade.
    serveStdio(buildServer);
}
