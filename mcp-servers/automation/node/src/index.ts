import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../../.env') });

const AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = 'https://automation-api.pixelz.com/v1';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function redactSecrets(text: string): string {
    let s = text;
    for (const key of ['PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET']) {
        const val = process.env[key];
        if (val) s = s.replaceAll(val, '<REDACTED>');
    }
    return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>');
}

const logFile = process.env.PIXELZ_LOG_FILE;
function log(level: string, message: string, data?: any) {
    if (!logFile) return;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    fs.appendFile(logFile, entry, () => {});
}

function validateId(value: string, name: string) {
    if (!/^[a-zA-Z0-9_\-]+$/.test(value)) {
        throw new Error(`Invalid ${name}: contains unexpected characters`);
    }
}

const tokenCache = { token: null as string | null, expiresAt: 0 };

async function getAccessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }
    const clientId = process.env.PIXELZ_AUTOMATION_CLIENT_ID;
    const clientSecret = process.env.PIXELZ_AUTOMATION_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("[AUTH_ERROR] Missing PIXELZ_AUTOMATION_CLIENT_ID or PIXELZ_AUTOMATION_CLIENT_SECRET in .env");
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    log('info', 'Requesting new OAuth token');
    const response = await axios.post(AUTH_URL, params, { timeout: REQUEST_TIMEOUT });
    tokenCache.token = response.data.access_token;
    tokenCache.expiresAt = Date.now() + ((response.data.expires_in || 3600) - 60) * 1000;
    return tokenCache.token!;
}

const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp'
};

async function ensureUrlOrId(input: string, token: string) {
    if (!input) return null;
    if (input.startsWith('http://') || input.startsWith('https://')) return input;
    if (!fs.existsSync(input)) throw new Error(`Local file not found: ${input}`);
    const fileSize = fs.statSync(input).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const fileName = path.basename(input);
    log('info', 'Requesting upload URL', { fileName });
    const presignRes = await axios.post(`${BASE_URL}/files/request-upload-url`, { fileName }, { headers: { 'Authorization': `Bearer ${token}` }, timeout: REQUEST_TIMEOUT });
    const uploadUrl = presignRes.data.url;
    const contentType = MIME_TYPES[path.extname(input).toLowerCase()] || 'application/octet-stream';
    const fileStream = fs.createReadStream(input);
    log('info', 'Uploading file', { fileName, size: fileSize });
    await axios.put(uploadUrl, fileStream, { headers: { 'Content-Type': contentType, 'Content-Length': String(fileSize) }, timeout: REQUEST_TIMEOUT, maxContentLength: Infinity, maxBodyLength: Infinity });
    return uploadUrl;
}

const server = new Server({ name: "pixelz-automation-mcp", version: "1.3.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "remove_background",
                description: "AI-powered background removal. Default: async — returns job_id immediately; call get_job_status every 30–60 seconds. featherWidth softens edges (0–1=sharp, >1=soft). Pass trimapUrl from create_trimap for complex edges. Only set sync=true if the user explicitly requests synchronous processing (risk of timeout).",
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
                description: "AI-powered color correction. Default: async — returns job_id immediately; call get_job_status every 30–60 seconds. Only set sync=true if the user explicitly requests it.",
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
                description: "Generate a greyscale silhouette mask (white=subject, black=background). Default: async — returns job_id immediately; call get_job_status every 30–60 seconds. Only set sync=true if the user explicitly requests it.",
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
                description: "Crop a model photograph using anatomical landmarks. Default: async — returns job_id immediately; call get_job_status every 30–60 seconds. Locations: eye_higher, below_eye, btw_eye_and_nose, below_nose, between_nose_and_mouth, below_mouth, below_chin, chest, at_elbow_higher, at_elbow_lower, waist, below_buttock, main_body_axis, mid_thigh, above_knee, at_knee, below_knee. Only set sync=true if the user explicitly requests it.",
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
                description: "Poll the status of any async Automation job. Call every 30–60 seconds. PENDING/PROCESSING = still working; FINISHED = result_image_url is ready; FAILED = report the error to the user and ask whether to resubmit.",
                inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }
            },
            {
                name: "get_webhook_public_key",
                description: "Retrieve the ECDSA public key used to verify Pixelz Automation webhook payload signatures. Store this key in your application to validate incoming webhook requests.",
                inputSchema: { type: "object", properties: {} }
            },
        ],
    };
});

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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const token = await getAccessToken();
    const { name, arguments: args } = request.params;
    try {
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
                const rbUrl = await ensureUrlOrId(p.imagePath, token);
                response = await axios.post(`${BASE_URL}/images/remove-background`, filterNull({
                    image_url: rbUrl,
                    background_color: p.backgroundColor,
                    transparent_background: p.transparentBackground ?? true,
                    feather_width: p.featherWidth,
                    trimap_url: p.trimapUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "color_matching": {
                const p = ColorMatchingSchema.parse(args);
                const cmUrl = await ensureUrlOrId(p.imagePath, token);
                response = await axios.post(`${BASE_URL}/images/color-matching`, filterNull({
                    image_url: cmUrl,
                    color_markers: p.colorMarkers,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "create_mask": {
                const p = CreateMaskSchema.parse(args);
                const mUrl = await ensureUrlOrId(p.imagePath, token);
                response = await axios.post(`${BASE_URL}/images/create-mask`, filterNull({
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
                response = await axios.post(`${BASE_URL}/images/create-trimap`, filterNull({
                    image_url: tUrl,
                    callback_url: p.callbackUrl
                }), { headers: makeHeaders(p.sync === true), timeout: REQUEST_TIMEOUT });
                break;
            }
            case "model_crop": {
                const p = ModelCropSchema.parse(args);
                const mcUrl = await ensureUrlOrId(p.imagePath, token);
                response = await axios.post(`${BASE_URL}/images/model-crop`, filterNull({
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
                response = await axios.get(`${BASE_URL}/images/jobs/${p.jobId}/status`, { headers: h, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_webhook_public_key": {
                const h: Record<string, string> = { 'Authorization': `Bearer ${token}` };
                response = await axios.get(`${BASE_URL}/webhook/public-keys`, { headers: h, timeout: REQUEST_TIMEOUT });
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
            errorMsg = `[VALIDATION_ERROR] ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`;
        } else if (error.response) {
            const status = error.response.status;
            const data = error.response.data;
            errorMsg = `[HTTP_${status}] ${typeof data === 'object' ? JSON.stringify(data) : data}`;
        } else if (error.code === 'ECONNABORTED') {
            errorMsg = `[TIMEOUT] Request timed out after ${REQUEST_TIMEOUT / 1000} seconds`;
        } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            errorMsg = `[NETWORK_ERROR] ${error.message}`;
        } else {
            errorMsg = error.message;
        }
        errorMsg = redactSecrets(errorMsg);
        log('error', `Tool ${name} failed`, { error: errorMsg });
        return { content: [{ type: "text", text: `Error: ${errorMsg}` }], isError: true };
    }
});

export { server, getAccessToken, ensureUrlOrId, validateId, redactSecrets };

if (process.env.NODE_ENV !== 'test') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
