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

const BASE_URL = 'https://api.pixelz.com/REST.svc/JSON';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function redactSecrets(text: string): string {
    let s = text;
    for (const key of ['PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL']) {
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
    const fileSize = fs.statSync(input).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const auth = getAuthParams();
    const fileName = path.basename(input);
    log('info', 'Requesting presigned URL', { fileName });
    const presignRes = await axios.post(`${BASE_URL}/RequestPresignUrls`, { ...auth, imageNames: [fileName] }, { timeout: REQUEST_TIMEOUT });
    const presignData = presignRes.data;
    if (presignData && !Array.isArray(presignData) && presignData.ErrorCode) {
        throw new Error(
            `[PRESIGN_UNAVAILABLE] ${presignData.Message || 'Presigned URL request failed'}. ` +
            'Your account is not enabled for direct file uploads. ' +
            'Provide a publicly accessible image URL instead of a local file path.'
        );
    }
    if (!Array.isArray(presignData) || presignData.length === 0) {
        throw new Error('Presigned URL request returned an unexpected response.');
    }
    const { UploadUrl, DownloadUrl } = presignData[0];
    const fileStream = fs.createReadStream(input);
    log('info', 'Uploading file to S3', { fileName, size: fileSize });
    await axios.put(UploadUrl, fileStream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fileSize) }, timeout: REQUEST_TIMEOUT, maxContentLength: Infinity, maxBodyLength: Infinity });
    return DownloadUrl;
}

const server = new Server({ name: "pixelz-platform-mcp", version: "1.4.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
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
                        swatchColorCode: { type: "string" },
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
                        imagesPerPage: { type: "number", description: "Max 100" },
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
                        imagesPath: { type: "array", items: { type: "string" }, description: "Array of local file paths or public URLs of color swatch images" }
                    },
                    required: ["imagesPath"]
                }
            },
        ],
    };
});

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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const auth = getAuthParams();
    const { name, arguments: args } = request.params;
    try {
        let response;
        log('info', `Tool called: ${name}`, args);
        switch (name) {
            case "list_templates":
                response = await axios.get(`${BASE_URL}/Templates`, { params: auth, timeout: REQUEST_TIMEOUT });
                break;
            case "get_template_detail": {
                const p = TemplateIdSchema.parse(args);
                validateId(p.templateId, 'templateId');
                response = await axios.get(`${BASE_URL}/Template/${p.templateId}`, { params: auth, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "upload_image": {
                const p = UploadImageSchema.parse(args);
                const url = await ensureUrl(p.imagePath);
                const { imagePath: _ip, ...uploadArgs } = p;
                response = await axios.post(`${BASE_URL}/Image`, { ...auth, ...uploadArgs, imageURL: url }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "white_glove_service": {
                const p = WhiteGloveSchema.parse(args);
                const wgUrl = await ensureUrl(p.imagePath);
                const { imagePath: _wgip, ...wgArgs } = p;
                response = await axios.post(`${BASE_URL}/WhiteGloveService`, { ...auth, ...wgArgs, imageURL: wgUrl }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "stack_image": {
                const p = StackImageSchema.parse(args);
                const sUrl = await ensureUrl(p.imagePath);
                const { imagePath: _sip, ...stackArgs } = p;
                response = await axios.post(`${BASE_URL}/StackImage`, { ...auth, ...stackArgs, imageURL: sUrl }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_image_status": {
                const p = ImageTicketSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                response = await axios.get(`${BASE_URL}/Image/${p.imageTicket}`, { params: { ...auth, customerImageId: p.customerImageId }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "list_images": {
                const p = ListImagesSchema.parse(args);
                const listParams = { ...p, imageStatus: resolveStatus(p.imageStatus), excludeImageStatus: resolveStatus(p.excludeImageStatus) };
                response = await axios.get(`${BASE_URL}/Images`, { params: { ...auth, ...listParams }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "count_images": {
                const p = CountImagesSchema.parse(args);
                const countParams = { ...p, imageStatus: resolveStatus(p.imageStatus) };
                response = await axios.get(`${BASE_URL}/Images/Count`, { params: { ...auth, ...countParams }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "list_product_ids": {
                const p = ListProductIdsSchema.parse(args);
                response = await axios.get(`${BASE_URL}/ProductIds`, { params: { ...auth, page: p.page, productIdsPerPage: p.perPage }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "delete_image": {
                const p = ImageTicketSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                response = await axios.delete(`${BASE_URL}/Image/${p.imageTicket}`, { data: { ...auth, ...p }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "reject_image": {
                const p = RejectImageSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                response = await axios.put(`${BASE_URL}/Image/Reject/${p.imageTicket}`, { ...auth, ...p }, { timeout: REQUEST_TIMEOUT });
                break;
            }
            case "get_contact":
                response = await axios.get(`${BASE_URL}/Contact`, { params: auth, timeout: REQUEST_TIMEOUT });
                break;
            case "get_invoices": {
                const p = GetInvoicesSchema.parse(args);
                response = await axios.get(`${BASE_URL}/Invoices`, { params: { ...auth, ...p }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "add_color_library": {
                const p = AddColorLibrarySchema.parse(args);
                const resolvedUrls = await Promise.all(p.imagesPath.map(img => ensureUrl(img)));
                response = await axios.post(`${BASE_URL}/AddColorLibrary`, { ...auth, imagesUrl: resolvedUrls }, { timeout: REQUEST_TIMEOUT });
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

export { server, getAuthParams, checkApiError, ensureUrl, validateId, redactSecrets, AddColorLibrarySchema };

if (process.env.NODE_ENV !== 'test') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
