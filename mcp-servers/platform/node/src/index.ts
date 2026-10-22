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

const BASE_URL = 'https://api.pixelz.com/REST.svc/JSON';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_RETRIES = 3;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
// Same methods urllib3 retries by default, so Node matches the Python sibling. POST is excluded:
// it creates billable jobs, and a 502/504 can arrive after the backend already accepted one.
const RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

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

async function readBody(res: Response): Promise<any> {
    const text = await res.text();
    try { return text ? JSON.parse(text) : ''; } catch { return text; }
}

async function backoff(attempt: number, retryAfter: string | null) {
    // Retry-After may be an HTTP-date rather than seconds; anything non-numeric falls back to backoff.
    const secs = retryAfter == null ? NaN : Number(retryAfter);
    const delay = Number.isFinite(secs) ? secs * 1000 : Math.min(1000 * 2 ** attempt, 30000);
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
        let res: Response;
        try {
            res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout) });
        } catch (e: any) {
            const code = networkCode(e);
            if (retryable && (code === 'ECONNRESET' || code === 'ETIMEDOUT')) { await backoff(attempt, null); continue; }
            // Deliberately no URL in the message: Platform credentials travel in the query string.
            throw Object.assign(new Error(code ? `${e.message} (${code})` : e.message), { code, network: code !== 'ECONNABORTED' });
        }
        if (res.ok) return { status: res.status, data: await readBody(res) };
        if (retryable && RETRY_STATUS.has(res.status)) {
            const retryAfter = res.headers.get('retry-after');
            await res.body?.cancel();
            await backoff(attempt, retryAfter);
            continue;
        }
        throw Object.assign(new Error(`Request failed with status code ${res.status}`),
            { response: { status: res.status, data: await readBody(res) } });
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
// limit must include the transfer itself. Assumes the link sustains at least 256 KB/s.
const uploadTimeout = (size: number) => REQUEST_TIMEOUT + Math.ceil(size / (256 * 1024)) * 1000;

function redactSecrets(text: string): string {
    let s = text;
    for (const key of ['PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL']) {
        const val = process.env[key];
        if (!val) continue;
        // Match raw AND percent-encoded forms: a credential echoed back inside a URL
        // appears encoded, where a literal match would silently miss it.
        for (const variant of new Set([val, encodeURIComponent(val), encodeURI(val)])) {
            s = s.replaceAll(variant, '<REDACTED>');
        }
    }
    // Backstop by param name, so an encoding the variants above miss still cannot leak.
    s = s.replace(/(contactAPIkey|contactEmail)=[^&\s'"]*/gi, '$1=<REDACTED>');
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

const getAuthParams = () => {
    const email = process.env.PIXELZ_PLATFORM_EMAIL;
    const apiKey = process.env.PIXELZ_PLATFORM_API_KEY;
    if (!email || !apiKey) {
        throw new Error("[AUTH_ERROR] Missing PIXELZ_PLATFORM_EMAIL or PIXELZ_PLATFORM_API_KEY in .env");
    }
    return { contactEmail: email, contactAPIkey: apiKey };
};

function checkApiError(data: any) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const code = data.ErrorCode;
        if (code !== undefined && code !== 'NoError' && code !== 0) {
            throw new Error(`[API_ERROR] ${code}: ${data.Message || ''}`);
        }
    }
}

async function ensureUrl(input: string) {
    if (!input) return null;
    if (input.startsWith('http://') || input.startsWith('https://')) return input;
    if (!fs.existsSync(input)) throw new Error(`Local file not found: ${input}`);
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Not a regular file: ${input}`);
    const fileSize = fs.statSync(resolved).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const auth = getAuthParams();
    const fileName = path.basename(resolved);
    log('info', 'Requesting presigned URL', { fileName });
    const presignRes = await http.post(`${BASE_URL}/RequestPresignUrls`, { ...auth, imageNames: [fileName] }, { timeout: REQUEST_TIMEOUT });
    const presignData = presignRes.data;
    // Documented shape is {ErrorCode: "NoError", Message: "", PostingUrls: [...]}. ErrorCode is
    // always present, so only a value other than NoError is a failure.
    const code = Array.isArray(presignData) ? undefined : presignData?.ErrorCode;
    if (code != null && code !== 'NoError' && code !== 0) {
        if (code === 'InvalidCustomerInformation') {
            throw new Error(`[AUTH_ERROR] Platform API rejected the credentials: ${presignData.Message || ''}`);
        }
        throw new Error(
            `[PRESIGN_UNAVAILABLE] ${code}: ${presignData.Message || 'Presigned URL request failed'}. ` +
            'The account may not be enabled for direct file uploads. ' +
            'Provide a publicly accessible image URL instead of a local file path.'
        );
    }
    // A bare array is still accepted, as this code originally assumed that shape.
    const postingUrls = Array.isArray(presignData) ? presignData : presignData?.PostingUrls;
    if (!Array.isArray(postingUrls) || postingUrls.length === 0) {
        throw new Error('Presigned URL request returned an unexpected response.');
    }
    const { UploadUrl, DownloadUrl } = postingUrls[0];
    log('info', 'Uploading file to S3', { fileName, size: fileSize });
    await http.put(UploadUrl, new UploadFile(resolved), { headers: { 'Content-Type': 'application/octet-stream' }, timeout: uploadTimeout(fileSize) });
    return DownloadUrl;
}

const TOOLS = [
            {
                name: "list_templates",
                description: "List all retouching specification templates available in the Pixelz account. Call this first to discover the templateId required for upload_image.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_template_detail",
                description: "Get the full technical configuration of a specific Pixelz template, including output format, background type, margins, alignment, and price per image.",
                inputSchema: { type: "object", properties: { templateId: { type: "string", description: "Numeric template ID from list_templates" } }, required: ["templateId"] }
            },
            {
                name: "upload_image",
                description: "Submit an image for professional manual retouching on the Pixelz Platform. Accepts a local file path or public URL — local files are uploaded to S3 automatically. Returns an ImageTicket GUID; use get_image_status to track progress.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL of the primary image" },
                        templateId: { type: "string", description: "Numeric specification ID. Use list_templates to find the right one." },
                        imageURL2: { type: "string" }, imageURL3: { type: "string" },
                        imageURL4: { type: "string" }, imageURL5: { type: "string" },
                        colorReferenceFileURL: { type: "string" },
                        imageCallbackURL: { type: "string", description: "Webhook URL for completion notification" },
                        customerImageId: { type: "string" },
                        productId: { type: "string" },
                        customerFolder: { type: "string" },
                        imageDeadlineDateTimeUTC: { type: "string", description: "yyyy-MM-dd HH:mm:ss, must be at least 24h in future" },
                        comment: { type: "string", description: "Instructions for the retouching expert" },
                        markupImageUrl: { type: "string" },
                        swatchImageURL: { type: "string" },
                        swatchColorCode: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$", description: "Hex color like #FFFFFF" },
                        markerX: { type: "number" }, markerY: { type: "number" },
                        outputFileName: { type: "string" },
                        customerImageColorID: { type: "string" },
                        colorwayIds: { type: "array", items: { type: "number" }, description: "Array of color library IDs from add_color_library" }
                    },
                    required: ["imagePath", "templateId"]
                }
            },
            {
                name: "white_glove_service",
                description: "Submit an image for retouching when you don't know which template to use. A Pixelz specialist manually reviews and selects the best settings. Accepts local file path or public URL.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        comment: { type: "string", description: "Instructions or context for the specialist" },
                        markupImageUrl: { type: "string" },
                        imageURL2: { type: "string" }, imageURL3: { type: "string" },
                        imageURL4: { type: "string" }, imageURL5: { type: "string" },
                        customerImageId: { type: "string" },
                        productId: { type: "string" },
                        customerFolder: { type: "string" },
                        imageCallbackURL: { type: "string" }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "stack_image",
                description: "Submit one part of a multi-image stack (e.g. different angles of the same product). All parts must share the same productId and be submitted within 5 minutes of each other.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        templateId: { type: "string" },
                        customerImageId: { type: "string" },
                        productId: { type: "string", description: "Must be identical across all parts of the same stack" },
                        customerFolder: { type: "string" },
                        imageDeadlineDateTimeUTC: { type: "string" },
                        imageCallbackURL: { type: "string" }
                    },
                    required: ["imagePath"]
                }
            },
            {
                name: "get_image_status",
                description: "Get the processing status of an uploaded image. Status codes: 10=New, 60=In Production, 70=Production Finished (QC), 80=Delivered. When status is 80 the FinalImagesURL is ready for download.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imageTicket: { type: "string", description: "GUID returned by upload_image or white_glove_service" },
                        customerImageId: { type: "string" }
                    },
                    required: ["imageTicket"]
                }
            },
            {
                name: "list_images",
                description: "Search and list images in the account with optional filters. Returns ticket IDs, statuses, and dates. Status accepts codes or names: 10/new, 60/in production, 70/production finished, 80/delivered.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imageStatus: { type: "string", description: "Filter by status code or name (10/new, 60/in production, 70/production finished, 80/delivered)" },
                        excludeImageStatus: { type: "string", description: "Exclude by status code or name" },
                        productId: { type: "string" },
                        fromDate: { type: "string", description: "YYYY-MM-DD" },
                        toDate: { type: "string", description: "YYYY-MM-DD" },
                        page: { type: "number" },
                        imagesPerPage: { type: "number", maximum: 100, description: "Max 100" },
                        sortBy: { type: "string", enum: ["id", "date", "status"] },
                        isDescending: { type: "string", enum: ["true", "false"] }
                    }
                }
            },
            {
                name: "count_images",
                description: "Get a count of images matching the given filters. Faster than list_images when you only need a total number.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imageStatus: { type: "string", description: "Filter by status code or name (10/new, 60/in production, 70/production finished, 80/delivered)" },
                        fromDate: { type: "string", description: "YYYY-MM-DD" },
                        toDate: { type: "string", description: "YYYY-MM-DD" }
                    }
                }
            },
            {
                name: "list_product_ids",
                description: "List product IDs with completion statistics (TodoCount vs DoneCount). Useful for tracking whether an entire product batch has been fully retouched.",
                inputSchema: { type: "object", properties: { page: { type: "number" }, perPage: { type: "number" } } }
            },
            {
                name: "delete_image",
                description: "Cancel and delete an image processing request. Only possible before the image enters production (status < 60). Confirm the ticket with the user before calling.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imageTicket: { type: "string" },
                        customerImageId: { type: "string" }
                    },
                    required: ["imageTicket"]
                }
            },
            {
                name: "reject_image",
                description: "Request a correction (redo) for a delivered image. Only valid when status is 80 (Delivered). The image re-enters the production queue at no extra charge.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imageTicket: { type: "string" },
                        comment: { type: "string", description: "Clear description of what needs fixing — sent directly to the retouching expert" },
                        markupImageUrl: { type: "string", description: "URL to an annotated image showing exactly what needs correcting" },
                        customerImageId: { type: "string" }
                    },
                    required: ["imageTicket", "comment"]
                }
            },
            {
                name: "get_contact",
                description: "Retrieve account profile information including company details and current credit balance (ContactAccountBalance and Currency).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_invoices",
                description: "Retrieve billing statements. Returns invoice amounts, dates, and payment URLs.",
                inputSchema: {
                    type: "object",
                    properties: {
                        fromDate: { type: "string", description: "YYYY-MM-DD" },
                        toDate: { type: "string", description: "YYYY-MM-DD" },
                        page: { type: "number" },
                        returnUrl: { type: "string", description: "Redirect URL after payment completion" }
                    }
                }
            },
            {
                name: "add_color_library",
                description: "Register color reference images (swatches) for use with color matching. Returns colorwayIds that can be passed to upload_image. Accepts local file paths or public URLs — local files are uploaded to S3 automatically.",
                inputSchema: {
                    type: "object",
                    properties: {
                        imagesPath: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Array of local file paths or public URLs of color swatch images" }
                    },
                    required: ["imagesPath"]
                }
            },
] as const;

// --- Status aliases (human-readable names → API numeric codes) ---
const STATUS_ALIASES: Record<string, string> = {
    'new': '10', 'in production': '60', 'production finished': '70', 'delivered': '80'
};
function resolveStatus(value: string | undefined): string | undefined {
    if (!value) return value;
    return STATUS_ALIASES[value.toLowerCase()] || value;
}

// --- Zod validation schemas ---
const TemplateIdSchema = z.object({ templateId: z.string().min(1) });

const UploadImageSchema = z.object({
    imagePath: z.string().min(1),
    templateId: z.string().min(1),
    imageURL2: z.string().optional(), imageURL3: z.string().optional(),
    imageURL4: z.string().optional(), imageURL5: z.string().optional(),
    colorReferenceFileURL: z.string().optional(),
    imageCallbackURL: z.string().optional(),
    customerImageId: z.string().optional(),
    productId: z.string().optional(),
    customerFolder: z.string().optional(),
    imageDeadlineDateTimeUTC: z.string().optional(),
    comment: z.string().optional(),
    markupImageUrl: z.string().optional(),
    swatchImageURL: z.string().optional(),
    swatchColorCode: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #FFFFFF').optional(),
    markerX: z.number().optional(), markerY: z.number().optional(),
    outputFileName: z.string().optional(),
    customerImageColorID: z.string().optional(),
    colorwayIds: z.array(z.number()).optional(),
});

const WhiteGloveSchema = z.object({
    imagePath: z.string().min(1),
    comment: z.string().optional(),
    markupImageUrl: z.string().optional(),
    imageURL2: z.string().optional(), imageURL3: z.string().optional(),
    imageURL4: z.string().optional(), imageURL5: z.string().optional(),
    customerImageId: z.string().optional(),
    productId: z.string().optional(),
    customerFolder: z.string().optional(),
    imageCallbackURL: z.string().optional(),
});

const StackImageSchema = z.object({
    imagePath: z.string().min(1),
    templateId: z.string().optional(),
    customerImageId: z.string().optional(),
    productId: z.string().optional(),
    customerFolder: z.string().optional(),
    imageDeadlineDateTimeUTC: z.string().optional(),
    imageCallbackURL: z.string().optional(),
});

const ImageTicketSchema = z.object({
    imageTicket: z.string().min(1),
    customerImageId: z.string().optional(),
});

const ListImagesSchema = z.object({
    imageStatus: z.string().optional(),
    excludeImageStatus: z.string().optional(),
    productId: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    page: z.number().optional(),
    imagesPerPage: z.number().max(100).optional(),
    sortBy: z.enum(["id", "date", "status"]).optional(),
    isDescending: z.enum(["true", "false"]).optional(),
});

const CountImagesSchema = z.object({
    imageStatus: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
});

const ListProductIdsSchema = z.object({
    page: z.number().optional(),
    perPage: z.number().optional(),
});

const RejectImageSchema = z.object({
    imageTicket: z.string().min(1),
    comment: z.string().min(1),
    markupImageUrl: z.string().optional(),
    customerImageId: z.string().optional(),
});

const AddColorLibrarySchema = z.object({
    imagesPath: z.array(z.string().min(1)).min(1),
});

const GetInvoicesSchema = z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    page: z.number().optional(),
    returnUrl: z.string().optional(),
});

async function callTool(name: string, args: any) {
    try {
        // Inside the try: getAuthParams() throws when credentials are missing, and callers
        // are promised a structured [AUTH_ERROR] result rather than a protocol-level throw.
        const auth = getAuthParams();
        let response;
        log('info', `Tool called: ${name}`, args);
        switch (name) {
            case "list_templates":
                response = await http.get(`${BASE_URL}/Templates`, { params: auth, timeout: REQUEST_TIMEOUT });
                break;
            case "get_template_detail": {
                const p = TemplateIdSchema.parse(args);
                validateId(p.templateId, 'templateId');
                response = await http.get(`${BASE_URL}/Template/${p.templateId}`, { params: auth, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "upload_image": {
                const p = UploadImageSchema.parse(args);
                const url = await ensureUrl(p.imagePath);
                const { imagePath: _ip, ...uploadArgs } = p;
                response = await http.post(`${BASE_URL}/Image`, { ...auth, ...uploadArgs, imageURL: url }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "white_glove_service": {
                const p = WhiteGloveSchema.parse(args);
                const wgUrl = await ensureUrl(p.imagePath);
                const { imagePath: _wgip, ...wgArgs } = p;
                response = await http.post(`${BASE_URL}/WhiteGloveService`, { ...auth, ...wgArgs, imageURL: wgUrl }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "stack_image": {
                const p = StackImageSchema.parse(args);
                const sUrl = await ensureUrl(p.imagePath);
                const { imagePath: _sip, ...stackArgs } = p;
                response = await http.post(`${BASE_URL}/StackImage`, { ...auth, ...stackArgs, imageURL: sUrl }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_image_status": {
                const p = ImageTicketSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                response = await http.get(`${BASE_URL}/Image/${p.imageTicket}`, { params: { ...auth, customerImageId: p.customerImageId }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "list_images": {
                const p = ListImagesSchema.parse(args);
                const listParams = { ...p, imageStatus: resolveStatus(p.imageStatus), excludeImageStatus: resolveStatus(p.excludeImageStatus) };
                response = await http.get(`${BASE_URL}/Images`, { params: { ...auth, ...listParams }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "count_images": {
                const p = CountImagesSchema.parse(args);
                const countParams = { ...p, imageStatus: resolveStatus(p.imageStatus) };
                response = await http.get(`${BASE_URL}/Images/Count`, { params: { ...auth, ...countParams }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "list_product_ids": {
                const p = ListProductIdsSchema.parse(args);
                response = await http.get(`${BASE_URL}/ProductIds`, { params: { ...auth, page: p.page, productIdsPerPage: p.perPage }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "delete_image": {
                const p = ImageTicketSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                response = await http.delete(`${BASE_URL}/Image/${p.imageTicket}`, { body: { ...auth, ...p }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "reject_image": {
                const p = RejectImageSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                response = await http.put(`${BASE_URL}/Image/Reject/${p.imageTicket}`, { ...auth, ...p }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_contact":
                response = await http.get(`${BASE_URL}/Contact`, { params: auth, timeout: REQUEST_TIMEOUT });
                break;
            case "get_invoices": {
                const p = GetInvoicesSchema.parse(args);
                response = await http.get(`${BASE_URL}/Invoices`, { params: { ...auth, ...p }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "add_color_library": {
                const p = AddColorLibrarySchema.parse(args);
                const resolvedUrls = await Promise.all(p.imagesPath.map(img => ensureUrl(img)));
                response = await http.post(`${BASE_URL}/AddColorLibrary`, { ...auth, imagesUrl: resolvedUrls }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            default:
                throw new Error("Unknown tool");
        }
        checkApiError(response.data);
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
// AJV pass reject first, so every rejection carries this project's documented
// `[VALIDATION_ERROR] field: reason` contract, which the skills tell users to expect.
// The advertised JSON Schema now states the same bounds Zod enforces, so agents can predict
// a rejection before calling; Zod stays the single authority that produces the message.
const passThroughValidator: jsonSchemaValidator = {
    getValidator: <T,>() => (input: unknown): JsonSchemaValidatorResult<T> =>
        ({ valid: true, data: input as T, errorMessage: undefined })
};

// One factory call per connection; serveStdio pins the instance for its lifetime.
function buildServer() {
    const server = new McpServer(
        { name: "pixelz-platform-mcp", version: "2.0.0" },
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

export { buildServer, callTool, TOOLS, getAuthParams, checkApiError, ensureUrl, validateId, redactSecrets, AddColorLibrarySchema };

if (process.env.NODE_ENV !== 'test') {
    // legacy: 'serve' (the default) keeps pre-2026 clients working through the
    // initialize handshake, so older agent CLIs are unaffected by the v2 upgrade.
    serveStdio(buildServer);
}
