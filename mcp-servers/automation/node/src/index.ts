import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { jsonSchemaValidator, JsonSchemaValidatorResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "path";
import { fileURLToPath } from 'url';
import { z } from "zod";
import { UploadFile, validateId, loadEnv, createRedactor, createLogger, createHttp, resolveLocalFile, readPackageVersion, isUrl, AUTOMATION_MIME_TYPES, AUTOMATION_UPLOAD_EXTENSIONS, HEX_COLOR, CROP_LOCATIONS, UPLOAD_UNAVAILABLE } from '../../../../shared/node/pixelz-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.resolve(__dirname, '../../../../.env'));

const readRepoVersion = (): string => readPackageVersion(path.resolve(__dirname, '../../../../package.json'));

const AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = 'https://automation-api.pixelz.com/v1';
const REQUEST_TIMEOUT = 90000;

const redactSecrets = createRedactor({
    envKeys: ['PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET'],
    paramNames: ['client_id', 'client_secret'],
});
const log = createLogger(redactSecrets);
const { http, uploadTimeout } = createHttp({ timeout: REQUEST_TIMEOUT, redactSecrets });

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

async function ensureUrlOrId(input: string, token: string) {
    if (!input) return null;
    if (isUrl(input)) return input;
    const { resolved, fileSize } = resolveLocalFile(input, AUTOMATION_UPLOAD_EXTENSIONS);
    const fileName = path.basename(resolved);
    log('info', 'Requesting upload URL', { fileName });
    let presignRes;
    try {
        presignRes = await http.post(`${BASE_URL}/files/request-upload-url`, { fileName }, { headers: { 'Authorization': `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
    } catch (e: any) {
        if (e.response?.status === 403) {
            throw new Error(UPLOAD_UNAVAILABLE);
        }
        throw e;
    }
    const uploadUrl = presignRes.data?.url;
    if (!uploadUrl) throw new Error('Upload URL request returned an unexpected response.');
    const contentType = AUTOMATION_MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    log('info', 'Uploading file', { fileName, size: fileSize });
    await http.put(uploadUrl, new UploadFile(resolved), { headers: { 'Content-Type': contentType }, timeout: uploadTimeout(fileSize) });
    return uploadUrl;
}

// MCP tool annotations (hints for clients deciding whether to ask the user before a call).
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const CREATES_JOB = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

// Mirrors the OpenAPI ColorMarker/SwatchImage schemas; ColorMarkerSchema below enforces the same rules.
const COLOR_MARKER_JSON_SCHEMA = {
    type: "object",
    properties: {
        x_coordinate: { type: "integer", description: "Horizontal pixel position of the colour sample in the main image (centre of a 30x30 block; avoid shadows/highlights)." },
        y_coordinate: { type: "integer", description: "Vertical pixel position of the colour sample in the main image." },
        swatch_color_code: { type: "string", pattern: HEX_COLOR.source, description: "Target colour as #RRGGBB. Mutually exclusive with swatch_image." },
        swatch_image: {
            type: "object",
            description: "Reference swatch image. Mutually exclusive with swatch_color_code.",
            properties: {
                swatch_image_url: { type: "string", description: "Public URL of the swatch image." },
                x_coordinate: { type: "integer", description: "Horizontal pixel position of the colour sample in the swatch image." },
                y_coordinate: { type: "integer", description: "Vertical pixel position of the colour sample in the swatch image." }
            },
            required: ["swatch_image_url", "x_coordinate", "y_coordinate"],
            additionalProperties: false
        }
    },
    required: ["x_coordinate", "y_coordinate"],
    additionalProperties: false
} as const;

const TOOLS = [
            {
                name: "remove_background",
                annotations: CREATES_JOB,
                description: "AI-powered background removal. Billed: 100 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. featherWidth softens edges (0–1=sharp, >1=soft). Pass trimapUrl from create_trimap for complex edges. Only set sync=true if the user explicitly requests synchronous processing (risk of timeout).",
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
                annotations: CREATES_JOB,
                description: "AI-powered color correction. Billed: 100 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. Only set sync=true if the user explicitly requests it.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        colorMarkers: {
                            type: "array",
                            description: "Array of marker objects. Each requires x_coordinate, y_coordinate, and exactly one of swatch_color_code (hex) or swatch_image (object with swatch_image_url, x_coordinate, y_coordinate).",
                            minItems: 1,
                            items: COLOR_MARKER_JSON_SCHEMA
                        },
                        callbackUrl: { type: "string" },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it." }
                    },
                    required: ["imagePath", "colorMarkers"]
                }
            },
            {
                name: "create_mask",
                annotations: CREATES_JOB,
                description: "Generate a greyscale silhouette mask (white=subject, black=background). Billed: 100 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. Only set sync=true if the user explicitly requests it.",
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
                annotations: CREATES_JOB,
                description: "Generate a trimap for complex subjects (hair, fur, transparent edges). Billed: 50 tokens per job. Default: async — returns job_id. Pass result trimapUrl to remove_background or create_mask for higher quality edges. Only set sync=true if the user explicitly requests it.",
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
                annotations: CREATES_JOB,
                description: `Crop a model photograph using anatomical landmarks. At least one of topCropLocation / bottomCropLocation is required. Billed: 10 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30–60 seconds; call get_job_status once to check, never in a loop. Locations: ${CROP_LOCATIONS.join(', ')}. Only set sync=true if the user explicitly requests it.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        topCropLocation: { type: "string", enum: CROP_LOCATIONS },
                        bottomCropLocation: { type: "string", enum: CROP_LOCATIONS },
                        callbackUrl: { type: "string" },
                        sync: { type: "boolean", description: "Run synchronously. Only use if user explicitly requests it." }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "get_job_status",
                annotations: READ_ONLY,
                description: "Check the status of any async Automation job (free). Most jobs finish in 30–60 seconds; large images can take several minutes. Call this once per check — never loop on it, since you cannot wait out an interval mid-turn. Read status.status_name: Created/ReadyForProcess/Processing = still working, report status and check again later; Completed or Delivered = result.result_image_url is ready; Failed = report the error to the user and ask whether to resubmit.",
                inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }
            },
            {
                name: "get_webhook_public_key",
                annotations: READ_ONLY,
                description: "Retrieve the ECDSA public key used to verify Pixelz Automation webhook payload signatures. Store this key in your application to validate incoming webhook requests.",
                inputSchema: { type: "object", properties: {} }
            },
] as const;

// --- Zod validation schemas ---
const RemoveBgSchema = z.object({
    imagePath: z.string().min(1),
    backgroundColor: z.string().regex(HEX_COLOR, 'Must be a hex color like #FFFFFF').optional(),
    transparentBackground: z.boolean().optional(),
    featherWidth: z.number().min(0).optional(),
    trimapUrl: z.string().optional(),
    callbackUrl: z.string().optional(),
    sync: z.boolean().optional(),
});

const SwatchImageSchema = z.object({
    swatch_image_url: z.string().min(1),
    x_coordinate: z.number().int(),
    y_coordinate: z.number().int(),
}).strict();

// The API takes exactly one of swatch_color_code / swatch_image per marker (null counts as unset).
const ColorMarkerSchema = z.object({
    x_coordinate: z.number().int(),
    y_coordinate: z.number().int(),
    swatch_color_code: z.string().regex(HEX_COLOR, 'Must be a hex color like #FFFFFF').nullish(),
    swatch_image: SwatchImageSchema.nullish(),
}).strict().refine(m => (m.swatch_color_code != null) !== (m.swatch_image != null),
    { message: 'exactly one of swatch_color_code or swatch_image is required' });

const ColorMatchingSchema = z.object({
    imagePath: z.string().min(1),
    colorMarkers: z.array(ColorMarkerSchema).min(1),
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

// Identifiers only: callback URLs and local paths in the arguments stay out of the log file.
function loggableArgs(args: any) {
    return typeof args?.jobId === 'string' ? { jobId: args.jobId } : undefined;
}

async function callTool(name: string, args: any) {
    try {
        let response;
        log('info', `Tool called: ${name}`, loggableArgs(args));

        const filterNull = (obj: Record<string, any>) => Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));

        const makeHeaders = (token: string, sync: boolean) => {
            const h: Record<string, string> = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
            if (!sync) h['Respond-Mode'] = 'async';
            return h;
        };

        // Each case validates its arguments first and only then fetches the token (inside the try:
        // getAccessToken() throws on missing credentials or a failed exchange, and callers are
        // promised a structured error result), so a bad argument needs no credentials or network.
        switch (name) {
            case "remove_background": {
                const p = RemoveBgSchema.parse(args);
                // The API takes exactly one of the two ("do not set both, and do not leave both unset"),
                // so transparency defaults to the opposite of whether a color was given.
                const transparent = p.transparentBackground ?? !p.backgroundColor;
                if (p.backgroundColor && transparent) throw new Error('[VALIDATION_ERROR] backgroundColor and transparentBackground=true cannot be used together');
                if (!p.backgroundColor && !transparent) throw new Error('[VALIDATION_ERROR] transparentBackground=false requires backgroundColor: set backgroundColor, or leave transparentBackground unset/true');
                const token = await getAccessToken();
                const rbUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/remove-background`, filterNull({
                    image_url: rbUrl,
                    background_color: p.backgroundColor || undefined,
                    transparent_background: transparent,
                    feather_width: p.featherWidth,
                    trimap_url: p.trimapUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(token, p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "color_matching": {
                const p = ColorMatchingSchema.parse(args);
                const token = await getAccessToken();
                const cmUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/color-matching`, filterNull({
                    image_url: cmUrl,
                    color_markers: p.colorMarkers,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(token, p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "create_mask": {
                const p = CreateMaskSchema.parse(args);
                const token = await getAccessToken();
                const mUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/create-mask`, filterNull({
                    image_url: mUrl,
                    feather_width: p.featherWidth,
                    trimap_url: p.trimapUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(token, p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "create_trimap": {
                const p = CreateTrimapSchema.parse(args);
                const token = await getAccessToken();
                const tUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/create-trimap`, filterNull({
                    image_url: tUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(token, p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "model_crop": {
                const p = ModelCropSchema.parse(args);
                // API rule: at least one of the two locations must be given.
                if (!p.topCropLocation && !p.bottomCropLocation) {
                    throw new Error('[VALIDATION_ERROR] at least one of topCropLocation or bottomCropLocation is required');
                }
                const token = await getAccessToken();
                const mcUrl = await ensureUrlOrId(p.imagePath, token);
                response = await http.post(`${BASE_URL}/images/model-crop`, filterNull({
                    image_url: mcUrl,
                    top_crop_location: p.topCropLocation,
                    bottom_crop_location: p.bottomCropLocation,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(token, p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_job_status": {
                const p = JobIdSchema.parse(args);
                validateId(p.jobId, 'jobId');
                const token = await getAccessToken();
                const h: Record<string, string> = { 'Authorization': `Bearer ${token}` };
                response = await http.get(`${BASE_URL}/images/jobs/${p.jobId}/status`, { headers: h, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_webhook_public_key": {
                const token = await getAccessToken();
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
            errorMsg = `[TIMEOUT] Request timed out after ${(error.timeoutMs ?? REQUEST_TIMEOUT) / 1000} seconds`;
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
        { name: "pixelz-automation-mcp", version: readRepoVersion() },
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
            { description: tool.description, annotations: tool.annotations, inputSchema: fromJsonSchema(tool.inputSchema, passThroughValidator) },
            async (args: any) => callTool(tool.name, args) as any
        );
    }
    return server;
}

export { buildServer, callTool, TOOLS, readRepoVersion, getAccessToken, ensureUrlOrId, validateId, redactSecrets,
    CROP_LOCATIONS, RemoveBgSchema, ModelCropSchema, ColorMatchingSchema, ColorMarkerSchema, JobIdSchema };

if (process.env.NODE_ENV !== 'test') {
    // legacy: 'serve' (the default) keeps pre-2026 clients working through the
    // initialize handshake, so older agent CLIs are unaffected by the v2 upgrade.
    serveStdio(buildServer);
}
