const path = require('path');
const { UploadFile, validateId, filterNull, loadEnv, createRedactor, createLogger, createHttp, resolveLocalFile, PLATFORM_UPLOAD_EXTENSIONS,
    isUrl, resolveStatus, checkApiError, parsePlatformPresign } =
    require(path.join(__dirname, '../../../shared/node/pixelz-common.js'));
const { fail, requireHex, flag, strings, runCli } = require(path.join(__dirname, '../../../shared/node/pixelz-cli.js'));
loadEnv(path.resolve(__dirname, '../../../.env'));

// Overridable so tests can point at a local stub and assert the exact outgoing params.
const BASE_URL = process.env.PIXELZ_PLATFORM_BASE_URL || 'https://api.pixelz.com/REST.svc/JSON';
// Overridable so tests can exercise the timeout path without waiting 90 s.
const REQUEST_TIMEOUT = (Number(process.env.PIXELZ_REQUEST_TIMEOUT_SECONDS) || 90) * 1000;

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
        console.error(`[AUTH_ERROR] Missing Platform API credentials.
Required: PIXELZ_PLATFORM_EMAIL and PIXELZ_PLATFORM_API_KEY in .env file.`);
        process.exit(1);
    }
    return { contactEmail: email, contactAPIkey: apiKey };
};

function parseJsonArray(name, text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw fail(`${name} is not valid JSON`);
    }
    if (!Array.isArray(parsed)) throw fail(`${name} must be a JSON array, e.g. [123,456]`);
    return parsed;
}

async function ensureUrl(input) {
    if (!input) return null;
    if (isUrl(input)) return input;
    const { resolved, fileSize } = resolveLocalFile(input, PLATFORM_UPLOAD_EXTENSIONS);
    const auth = getAuthParams();
    const fileName = path.basename(resolved);
    log('info', 'Requesting presigned URL', { fileName });
    const presignRes = await http.post(`${BASE_URL}/RequestPresignUrls`, {
        ...auth,
        imageNames: [fileName]
    }, { timeout: REQUEST_TIMEOUT });
    const { UploadUrl, DownloadUrl } = parsePlatformPresign(presignRes.data);
    log('info', 'Uploading file to S3', { fileName, size: fileSize });
    await http.put(UploadUrl, new UploadFile(resolved), {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: uploadTimeout(fileSize)
    });
    return DownloadUrl;
}

/** @typedef {Record<string, any>} Options parsed flags, keyed by the API's param names */

// Python's `if args.x:` skips an empty string where `is not None` would send it; keep Node the same.
const nonEmpty = (/** @type {any} */ v) => v || undefined;

const commands = {
    'list-templates': async () => {
        log('info', 'list-templates');
        const res = await http.get(`${BASE_URL}/Templates`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-template': async (/** @type {string[]} */ [id]) => {
        validateId(id, 'templateId');
        log('info', 'get-template', { id });
        const res = await http.get(`${BASE_URL}/Template/${id}`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'upload': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        const { template, colorwayIds, ...rest } = options;
        requireHex('--swatchColorCode', rest.swatchColorCode);
        const colorwayIdList = colorwayIds ? parseJsonArray('--colorwayIds', colorwayIds) : undefined;
        log('info', 'upload', { templateId: template });
        const url = await ensureUrl(input);
        const payload = filterNull({
            ...getAuthParams(),
            imageURL: url,
            templateId: template,
            ...rest,
            colorwayIds: colorwayIdList
        });
        const res = await http.post(`${BASE_URL}/Image`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'white-glove': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        log('info', 'white-glove');
        const url = await ensureUrl(input);
        const payload = filterNull({
            ...getAuthParams(),
            imageURL: url,
            ...options
        });
        const res = await http.post(`${BASE_URL}/WhiteGloveService`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'stack': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        const { template, ...rest } = options;
        log('info', 'stack', { templateId: template });
        const url = await ensureUrl(input);
        const payload = filterNull({
            ...getAuthParams(),
            imageURL: url,
            templateId: nonEmpty(template),
            ...rest
        });
        const res = await http.post(`${BASE_URL}/StackImage`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'status': async (/** @type {string[]} */ [ticket], /** @type {Options} */ options) => {
        validateId(ticket, 'imageTicket');
        log('info', 'status', { ticket });
        const params = filterNull({ ...getAuthParams(), customerImageId: nonEmpty(options.customerImageId) });
        const res = await http.get(`${BASE_URL}/Image/${ticket}`, {
            params, timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'list-images': async (/** @type {string[]} */ _pos, /** @type {Options} */ options) => {
        const { status, excludeImageStatus, ...rest } = options;
        if (rest.imagesPerPage != null && (rest.imagesPerPage < 1 || rest.imagesPerPage > 100)) {
            throw fail('--imagesPerPage must be between 1 and 100');
        }
        if (rest.sortBy != null && !['id', 'date', 'status'].includes(rest.sortBy)) {
            throw fail('--sortBy must be one of: id, date, status');
        }
        if (rest.isDescending != null && !['true', 'false'].includes(rest.isDescending)) {
            throw fail('--isDescending must be true or false');
        }
        log('info', 'list-images', options);
        const res = await http.get(`${BASE_URL}/Images`, {
            params: filterNull({
                ...getAuthParams(),
                imageStatus: resolveStatus(nonEmpty(status)),
                excludeImageStatus: resolveStatus(nonEmpty(excludeImageStatus)),
                ...rest
            }), timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'count-images': async (/** @type {string[]} */ _pos, /** @type {Options} */ options) => {
        log('info', 'count-images', options);
        const { status, ...rest } = options;
        const res = await http.get(`${BASE_URL}/Images/Count`, {
            params: filterNull({ ...getAuthParams(), imageStatus: resolveStatus(nonEmpty(status)), ...rest }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'list-products': async (/** @type {string[]} */ _pos, /** @type {Options} */ options) => {
        log('info', 'list-products', { page: options.page, perPage: options.perPage });
        const res = await http.get(`${BASE_URL}/ProductIds`, {
            params: filterNull({ ...getAuthParams(), page: options.page, productIdsPerPage: options.perPage }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'delete': async (/** @type {string[]} */ [ticket], /** @type {Options} */ options) => {
        validateId(ticket, 'imageTicket');
        log('info', 'delete', { ticket });
        const res = await http.delete(`${BASE_URL}/Image/${ticket}`, {
            body: filterNull({ ...getAuthParams(), customerImageId: nonEmpty(options.customerImageId) }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'reject': async (/** @type {string[]} */ [ticket, comment], /** @type {Options} */ options) => {
        validateId(ticket, 'imageTicket');
        log('info', 'reject', { ticket });
        const res = await http.put(`${BASE_URL}/Image/Reject/${ticket}`, filterNull({
            ...getAuthParams(),
            imageTicket: ticket,
            comment,
            customerImageId: nonEmpty(options.customerImageId),
            markupImageUrl: nonEmpty(options.markupImageUrl)
        }), { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-contact': async () => {
        log('info', 'get-contact');
        const res = await http.get(`${BASE_URL}/Contact`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-invoices': async (/** @type {string[]} */ _pos, /** @type {Options} */ options) => {
        log('info', 'get-invoices', options);
        const res = await http.get(`${BASE_URL}/Invoices`, {
            params: filterNull({ ...getAuthParams(), ...options }), timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'add-color-library': async (/** @type {string[]} */ imagePaths) => {
        log('info', 'add-color-library', { count: imagePaths.length });
        const resolvedUrls = await Promise.all(imagePaths.map(p => ensureUrl(p)));
        const payload = { ...getAuthParams(), imagesUrl: resolvedUrls };
        const res = await http.post(`${BASE_URL}/AddColorLibrary`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    }
};

// --- Command-line flag definitions (the parser itself is in shared/node/pixelz-cli.js) ---------

const IMG_FLAGS = strings('imageURL2', 'imageURL3', 'imageURL4', 'imageURL5', 'colorReferenceFileURL',
    'imageCallbackURL', 'customerImageId', 'productId', 'customerFolder');

/** @type {Record<string, import('../../../shared/node/pixelz-cli.js').CommandSpec>} */
const SPECS = {
    'list-templates': { positionals: [], flags: {} },
    'get-template': { positionals: ['id'], flags: {} },
    'upload': {
        positionals: ['input'], required: ['template'],
        flags: {
            ...flag('string', 'template', 'template', 'templateId'), ...IMG_FLAGS,
            ...strings('imageDeadlineDateTimeUTC', 'comment', 'markupImageUrl', 'swatchImageURL', 'swatchColorCode'),
            ...flag('int', 'markerX'), ...flag('int', 'markerY'),
            ...strings('outputFileName', 'customerImageColorID', 'colorwayIds'),
        },
    },
    'white-glove': { positionals: ['input'], flags: { ...IMG_FLAGS, ...strings('comment', 'markupImageUrl') } },
    'stack': {
        positionals: ['input'],
        flags: { ...flag('string', 'template', 'template', 'templateId'), ...IMG_FLAGS, ...strings('imageDeadlineDateTimeUTC') },
    },
    'status': { positionals: ['ticket'], flags: flag('string', 'customerImageId', 'customer-id', 'customerImageId') },
    'list-images': {
        positionals: [],
        flags: {
            ...flag('string', 'status', 'status', 'imageStatus'),
            ...strings('excludeImageStatus', 'productId', 'fromDate', 'toDate'),
            ...flag('int', 'page'), ...flag('int', 'imagesPerPage'),
            ...strings('sortBy', 'isDescending'),
        },
    },
    'count-images': {
        positionals: [],
        flags: { ...flag('string', 'status', 'status', 'imageStatus'), ...strings('fromDate', 'toDate') },
    },
    'list-products': {
        positionals: [],
        flags: { ...flag('int', 'page'), ...flag('int', 'perPage', 'per-page', 'perPage') },
    },
    'delete': { positionals: ['ticket'], flags: flag('string', 'customerImageId', 'customer-id', 'customerImageId') },
    'reject': {
        positionals: ['ticket', 'comment'],
        flags: { ...flag('string', 'customerImageId', 'customer-id', 'customerImageId'), ...strings('markupImageUrl') },
    },
    'get-contact': { positionals: [], flags: {} },
    'add-color-library': { positionals: ['images'], variadic: true, flags: {} },
    'get-invoices': { positionals: [], flags: { ...strings('fromDate', 'toDate'), ...flag('int', 'page'), ...strings('returnUrl') } },
};

const USAGE = `Pixelz Platform CLI

Usage: node cli.js <command> [args] [--options]

Commands:
  list-templates                          List retouching specification templates
  get-template <id>                       Get template details by ID
  upload <path|url> --template <id> [opts] Submit image for retouching
  white-glove <path|url> [opts]           Submit image for white-glove review
  stack <path|url> [--template <id>]      Submit image as part of a stack
  status <ticket> [--customer-id X]       Get image processing status
  list-images [--status X] [--fromDate]   List images (--status: any numeric status code, or the alias new/in production/production finished/delivered)
  count-images [--status X] [--fromDate]  Count images (--status as for list-images)
  list-products [--page N] [--per-page N] List product IDs with stats
  delete <ticket> [--customer-id X]       Cancel image processing
  reject <ticket> <comment> [opts]        Request correction for delivered image
  get-contact                             Get account profile and balance
  get-invoices [--fromDate] [--toDate]    Get billing statements
  add-color-library <path|url>...         Register color swatches, get colorwayIds

Status codes: --status and --excludeImageStatus accept any numeric Platform status code.
Only these names are aliases: new (10), in production (60), production finished (70), delivered (80).

Upload also accepts --colorwayIds='[123,456]' for color matching with registered swatches.

Options use --key=value or --key value syntax. A flag that takes a value must be given one.`;

runCli({
    usage: USAGE,
    specs: SPECS,
    commands,
    onError(err, cmd) {
        let msg;
        if (err.response) {
            const { status, data } = err.response;
            msg = `[HTTP_${status}] ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
        } else if (err.code === 'ECONNABORTED') {
            msg = '[TIMEOUT] Request timed out';
        } else if (err.network) {
            msg = `[NETWORK_ERROR] ${err.message}`;
        } else {
            // Messages raised with their own category (e.g. [AUTH_ERROR]) keep it as-is.
            msg = /^\[[A-Z0-9_]+\]/.test(err.message) ? err.message : `[API_ERROR] ${err.message}`;
        }
        msg = redactSecrets(msg);
        // Same failure line the Python CLI and the MCP servers write; log() redacts as well.
        log('error', `${cmd} failed`, { error: msg });
        console.error(msg);
        process.exit(1);
    },
});
