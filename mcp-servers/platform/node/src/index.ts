import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { jsonSchemaValidator, JsonSchemaValidatorResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "path";
import { fileURLToPath } from 'url';
import { z } from "zod";
import { UploadFile, validateId, loadEnv, createRedactor, createLogger, createHttp, resolveLocalFile, readPackageVersion, isUrl,
    resolveStatus, checkApiError, parsePlatformPresign, PLATFORM_UPLOAD_EXTENSIONS, HEX_COLOR } from '../../../../shared/node/pixelz-common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.resolve(__dirname, '../../../../.env'));

const readRepoVersion = (): string => readPackageVersion(path.resolve(__dirname, '../../../../package.json'));

const BASE_URL = 'https://api.pixelz.com/REST.svc/JSON';
const REQUEST_TIMEOUT = 90000;

const redactSecrets = createRedactor({
    envKeys: ['PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL'],
    paramNames: ['contactAPIkey', 'contactEmail'],
});
const log = createLogger(redactSecrets);
const { http, uploadTimeout } = createHttp({ timeout: REQUEST_TIMEOUT, redactSecrets });

const getAuthParams = () => {
    const email = process.env.PIXELZ_PLATFORM_EMAIL;
    const apiKey = process.env.PIXELZ_PLATFORM_API_KEY;
    if (!email || !apiKey) {
        throw new Error("[AUTH_ERROR] Missing PIXELZ_PLATFORM_EMAIL or PIXELZ_PLATFORM_API_KEY in .env");
    }
    return { contactEmail: email, contactAPIkey: apiKey };
};

async function ensureUrl(input: string) {
    if (!input) return null;
    if (isUrl(input)) return input;
    const { resolved, fileSize } = resolveLocalFile(input, PLATFORM_UPLOAD_EXTENSIONS);
    const auth = getAuthParams();
    const fileName = path.basename(resolved);
    log('info', 'Requesting presigned URL', { fileName });
    const presignRes = await http.post(`${BASE_URL}/RequestPresignUrls`, { ...auth, imageNames: [fileName] }, { timeout: REQUEST_TIMEOUT });
    const { UploadUrl, DownloadUrl } = parsePlatformPresign(presignRes.data);
    log('info', 'Uploading file to S3', { fileName, size: fileSize });
    await http.put(UploadUrl, new UploadFile(resolved), { headers: { 'Content-Type': 'application/octet-stream' }, timeout: uploadTimeout(fileSize) });
    return DownloadUrl;
}

// MCP tool annotations (hints for clients deciding whether to ask the user before a call).
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const CREATES_ORDER = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const TOOLS = [
            {
                name: "list_templates",
                description: "List all retouching specification templates available in the Pixelz account. Call this first to discover the templateId required for upload_image.",
                annotations: READ_ONLY,
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_template_detail",
                description: "Get the full technical configuration of a specific Pixelz template, including output format, background type, margins, alignment, and price per image.",
                annotations: READ_ONLY,
                inputSchema: { type: "object", properties: { templateId: { type: "string", description: "Numeric template ID from list_templates" } }, required: ["templateId"] }
            },
            {
                name: "upload_image",
                description: "Submit an image for professional manual retouching on the Pixelz Platform. Creates a billable retouching order. Accepts a local file path (images only) or public URL — local files are uploaded to S3 automatically. Returns an ImageTicket GUID; use get_image_status to track progress.",
                annotations: CREATES_ORDER,
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
                        swatchColorCode: { type: "string", pattern: HEX_COLOR.source, description: "Hex color like #FFFFFF" },
                        markerX: { type: "integer" }, markerY: { type: "integer" },
                        outputFileName: { type: "string" },
                        customerImageColorID: { type: "string" },
                        colorwayIds: { type: "array", items: { type: "number" }, description: "Array of color library IDs from add_color_library" }
                    },
                    required: ["imagePath", "templateId"]
                }
            },
            {
                name: "white_glove_service",
                description: "Submit an image for retouching when you don't know which template to use. A Pixelz specialist manually reviews and selects the best settings. Creates a billable retouching order. Accepts local file path or public URL.",
                annotations: CREATES_ORDER,
                inputSchema: {
                    type: "object",
                    properties: {
                        imagePath: { type: "string", description: "Local file path or public URL" },
                        comment: { type: "string", description: "Instructions or context for the specialist" },
                        markupImageUrl: { type: "string" },
                        imageURL2: { type: "string" }, imageURL3: { type: "string" },
                        imageURL4: { type: "string" }, imageURL5: { type: "string" },
                        colorReferenceFileURL: { type: "string" },
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
                description: "Submit one part of a multi-image stack (e.g. different angles of the same product). All parts must share the same productId and be submitted within 5 minutes of each other. Creates a billable retouching order.",
                annotations: CREATES_ORDER,
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
                description: "Get the processing status of an uploaded image. Codes: 10 new, 12 download failed, 20 awaiting payment (deprecated), 30 ready for production, 40 returned for production, 60 in production, 62 assigned to editor, 64 downloaded by editor, 66 quality assurance, 70 finished (ready for download), 72/74/76 delivery attempt 1/2/3 failed, 78 delivery failed, 80 delivered, 90 rejected by Pixelz, 95 awaiting your reply, 100 closed, 0 deleted by user, 999 deleted by cleanup. 12, 90 and 95 need user action: tell the user, do not retry. A non-empty FinalImagesURL means a result is downloadable.",
                annotations: READ_ONLY,
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
                description: "Search and list images in the account with optional filters. Returns ticket IDs, statuses, and dates. Status accepts any numeric code (see get_image_status); only new/in production/production finished/delivered are aliases for 10/60/70/80.",
                annotations: READ_ONLY,
                inputSchema: {
                    type: "object",
                    properties: {
                        imageStatus: { type: "string", description: "Filter by numeric status code, or alias: new, in production, production finished, delivered" },
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
                description: "Get a count of images matching the given filters. Faster than list_images when you only need a total number. Status accepts any numeric code (see get_image_status); only new/in production/production finished/delivered are aliases for 10/60/70/80.",
                annotations: READ_ONLY,
                inputSchema: {
                    type: "object",
                    properties: {
                        imageStatus: { type: "string", description: "Filter by numeric status code, or alias: new, in production, production finished, delivered" },
                        fromDate: { type: "string", description: "YYYY-MM-DD" },
                        toDate: { type: "string", description: "YYYY-MM-DD" }
                    }
                }
            },
            {
                name: "list_product_ids",
                description: "List product IDs with completion statistics (TodoCount vs DoneCount). Useful for tracking whether an entire product batch has been fully retouched.",
                annotations: READ_ONLY,
                inputSchema: { type: "object", properties: { page: { type: "number" }, perPage: { type: "number" } } }
            },
            {
                name: "delete_image",
                description: "Cancel and delete an image processing request. Only possible before the image enters production (status < 60). Confirm the ticket with the user before calling.",
                annotations: DESTRUCTIVE,
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
                annotations: CREATES_ORDER,
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
                annotations: READ_ONLY,
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_invoices",
                description: "Retrieve billing statements. Returns invoice amounts, dates, and payment URLs.",
                annotations: READ_ONLY,
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
                annotations: CREATES_ORDER,
                inputSchema: {
                    type: "object",
                    properties: {
                        imagesPath: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Array of local file paths or public URLs of color swatch images" }
                    },
                    required: ["imagesPath"]
                }
            },
] as const;

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
    swatchColorCode: z.string().regex(HEX_COLOR, 'Must be a hex color like #FFFFFF').optional(),
    markerX: z.number().int().optional(), markerY: z.number().int().optional(),
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
    colorReferenceFileURL: z.string().optional(),
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

// Identifiers only: comments, callback URLs and local paths in the arguments stay out of the log file.
function loggableArgs(args: any) {
    const out: Record<string, string | number> = {};
    for (const key of ['templateId', 'imageTicket'] as const) {
        if (typeof args?.[key] === 'string') out[key] = args[key];
    }
    if (Array.isArray(args?.imagesPath)) out.count = args.imagesPath.length;
    return Object.keys(out).length ? out : undefined;
}

async function callTool(name: string, args: any) {
    try {
        // Inside the try: getAuthParams() throws when credentials are missing, and callers
        // are promised a structured [AUTH_ERROR] result rather than a protocol-level throw.
        const auth = getAuthParams();
        let response;
        log('info', `Tool called: ${name}`, loggableArgs(args));
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
                // Same body as the Python server and the CLIs: credentials plus customerImageId, not the ticket.
                response = await http.delete(`${BASE_URL}/Image/${p.imageTicket}`, { body: { ...auth, ...(p.customerImageId ? { customerImageId: p.customerImageId } : {}) }, timeout: REQUEST_TIMEOUT });
                break;
            }
            case "reject_image": {
                const p = RejectImageSchema.parse(args);
                validateId(p.imageTicket, 'imageTicket');
                // The documented REJECT payload repeats imageTicket alongside the path segment.
                response = await http.put(`${BASE_URL}/Image/Reject/${p.imageTicket}`,
                    { ...auth, imageTicket: p.imageTicket, comment: p.comment, markupImageUrl: p.markupImageUrl, customerImageId: p.customerImageId },
                    { timeout: REQUEST_TIMEOUT });
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
        { name: "pixelz-platform-mcp", version: readRepoVersion() },
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

export { buildServer, callTool, TOOLS, readRepoVersion, getAuthParams, checkApiError, ensureUrl, validateId, redactSecrets,
    AddColorLibrarySchema, UploadImageSchema, RejectImageSchema, ListImagesSchema };

if (process.env.NODE_ENV !== 'test') {
    // legacy: 'serve' (the default) keeps pre-2026 clients working through the
    // initialize handshake, so older agent CLIs are unaffected by the v2 upgrade.
    serveStdio(buildServer);
}
