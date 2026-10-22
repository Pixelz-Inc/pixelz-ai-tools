const axios = require('axios');
const path = require('path');
const fs = require('fs');
// quiet: dotenv >=17 prints an 'injected env' banner to STDOUT by default, which
// corrupts the CLI's JSON output.
require('dotenv').config({ quiet: true, path: process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../.env') });

// Overridable so tests can point at a local stub and assert the exact outgoing params.
const BASE_URL = process.env.PIXELZ_PLATFORM_BASE_URL || 'https://api.pixelz.com/REST.svc/JSON';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_RETRIES = 3;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
// Same methods urllib3 retries by default, so Node matches the Python sibling. POST is excluded:
// it creates billable jobs, and a 502/504 can arrive after the backend already accepted one.
const RETRY_METHODS = new Set(['get', 'head', 'options', 'put', 'delete']);

const axiosRetry = axios.create();
axiosRetry.interceptors.response.use(undefined, async (error) => {
    const config = error.config;
    if (!config) throw error;
    config.__retryCount = config.__retryCount || 0;
    const status = error.response?.status;
    const isRetryable = RETRY_METHODS.has(config.method)
        && (RETRY_STATUS.has(status) || ['ECONNRESET', 'ETIMEDOUT'].includes(error.code));
    if (!isRetryable || config.__retryCount >= MAX_RETRIES) throw error;
    config.__retryCount++;
    // Retry-After may be an HTTP-date rather than seconds; anything non-numeric falls back to backoff.
    const retryAfter = Number(error.response?.headers?.['retry-after']);
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(1000 * 2 ** (config.__retryCount - 1), 30000);
    await new Promise(r => setTimeout(r, delay));
    // The first attempt consumed the upload stream; resending it would declare the full
    // Content-Length but send zero bytes and hang until timeout.
    if (config.data instanceof fs.ReadStream) config.data = fs.createReadStream(config.data.path);
    return axiosRetry(config);
});

function redactSecrets(text) {
    let s = String(text);
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
function log(level, message, data) {
    if (!logFile) return;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    // Redacted here, not at call sites: error text can carry a credentialed request URL.
    fs.appendFile(logFile, redactSecrets(entry), (err) => { if (err) process.stderr.write('Log write failed: ' + err.message + '\n'); });
}

function validateId(value, name) {
    if (!/^[a-zA-Z0-9_\-]+$/.test(value)) {
        throw new Error(`Invalid ${name}: contains unexpected characters`);
    }
}

function filterNull(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));
}

const STATUS_ALIASES = {
    'new': '10', 'in production': '60', 'production finished': '70', 'delivered': '80'
};

function resolveStatus(value) {
    if (value == null) return value;
    const lower = String(value).toLowerCase();
    return STATUS_ALIASES[lower] || value;
}

// The Platform API names these params `imageStatus` / `customerImageId`, but the
// documented CLI flags are the shorter `--status` / `--customer-id`. Accept the API
// spelling too so either form works, and always emit the API's name.
function pickStatus(options, key = 'status') {
    const apiKey = key === 'status' ? 'imageStatus' : key;
    return resolveStatus(options[key] ?? options[apiKey]);
}

function pickCustomerId(options) {
    return options['customer-id'] ?? options.customerImageId;
}

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

function checkApiError(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const code = data.ErrorCode;
        if (code !== undefined && code !== 'NoError' && code !== 0) {
            throw new Error(`[API_ERROR] ${code}: ${data.Message || ''}`);
        }
    }
}

async function ensureUrl(input) {
    if (!input) return null;
    if (input.startsWith('http://') || input.startsWith('https://')) {
        return input;
    }
    if (!fs.existsSync(input)) {
        throw new Error(`Local file not found: ${input}`);
    }
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Not a regular file: ${input}`);
    const fileSize = fs.statSync(resolved).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const auth = getAuthParams();
    const fileName = path.basename(resolved);
    log('info', 'Requesting presigned URL', { fileName });
    const presignRes = await axiosRetry.post(`${BASE_URL}/RequestPresignUrls`, {
        ...auth,
        imageNames: [fileName]
    }, { timeout: REQUEST_TIMEOUT });
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
    const fileStream = fs.createReadStream(resolved);
    log('info', 'Uploading file to S3', { fileName, size: fileSize });
    await axiosRetry.put(UploadUrl, fileStream, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fileSize) },
        timeout: REQUEST_TIMEOUT,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });
    return DownloadUrl;
}

const commands = {
    'list-templates': async () => {
        log('info', 'list-templates');
        const res = await axiosRetry.get(`${BASE_URL}/Templates`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-template': async (id) => {
        validateId(id, 'templateId');
        log('info', 'get-template', { id });
        const res = await axiosRetry.get(`${BASE_URL}/Template/${id}`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'upload': async (input, templateId, options = {}) => {
        log('info', 'upload', { templateId });
        const url = await ensureUrl(input);
        const payload = filterNull({
            ...getAuthParams(),
            imageURL: url,
            templateId,
            ...options
        });
        const res = await axiosRetry.post(`${BASE_URL}/Image`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'white-glove': async (input, options = {}) => {
        log('info', 'white-glove');
        const url = await ensureUrl(input);
        const payload = filterNull({
            ...getAuthParams(),
            imageURL: url,
            ...options
        });
        const res = await axiosRetry.post(`${BASE_URL}/WhiteGloveService`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'stack': async (input, templateId, options = {}) => {
        log('info', 'stack', { templateId });
        const url = await ensureUrl(input);
        const payload = filterNull({
            ...getAuthParams(),
            imageURL: url,
            templateId,
            ...options
        });
        const res = await axiosRetry.post(`${BASE_URL}/StackImage`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'status': async (ticket, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'status', { ticket });
        const params = filterNull({ ...getAuthParams(), customerImageId: pickCustomerId(options) });
        const res = await axiosRetry.get(`${BASE_URL}/Image/${ticket}`, {
            params, timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    /** @param {Record<string, any>} options parsed --flags; keys mirror the API's param names */
    'list-images': async (options = {}) => {
        log('info', 'list-images', options);
        /** @type {Record<string, any>} */
        const { status: _s, imageStatus: _is, excludeImageStatus: _es, ...rest } = options;
        if (rest.page) rest.page = parseInt(rest.page, 10);
        if (rest.imagesPerPage) rest.imagesPerPage = parseInt(rest.imagesPerPage, 10);
        const res = await axiosRetry.get(`${BASE_URL}/Images`, {
            params: filterNull({
                ...getAuthParams(),
                ...rest,
                imageStatus: pickStatus(options),
                excludeImageStatus: pickStatus(options, 'excludeImageStatus')
            }), timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'count-images': async (options = {}) => {
        log('info', 'count-images', options);
        const { status: _s, imageStatus: _is, ...rest } = options;
        const res = await axiosRetry.get(`${BASE_URL}/Images/Count`, {
            params: filterNull({ ...getAuthParams(), ...rest, imageStatus: pickStatus(options) }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'list-products': async (options = {}) => {
        const page = options.page;
        const perPage = options['per-page'] ?? options.perPage;
        log('info', 'list-products', { page, perPage });
        const res = await axiosRetry.get(`${BASE_URL}/ProductIds`, {
            params: filterNull({ ...getAuthParams(), page: page ? parseInt(page, 10) : undefined, productIdsPerPage: perPage ? parseInt(perPage, 10) : undefined }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'delete': async (ticket, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'delete', { ticket });
        const res = await axiosRetry.delete(`${BASE_URL}/Image/${ticket}`, {
            data: filterNull({ ...getAuthParams(), customerImageId: pickCustomerId(options) }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'reject': async (ticket, comment, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'reject', { ticket });
        const { 'customer-id': _cid, customerImageId: _cii, ...rest } = options;
        const res = await axiosRetry.put(`${BASE_URL}/Image/Reject/${ticket}`, filterNull({
            ...getAuthParams(),
            comment,
            ...rest,
            customerImageId: pickCustomerId(options)
        }), { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-contact': async () => {
        log('info', 'get-contact');
        const res = await axiosRetry.get(`${BASE_URL}/Contact`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-invoices': async (options = {}) => {
        log('info', 'get-invoices', options);
        if (options.page) options.page = parseInt(options.page, 10);
        const res = await axiosRetry.get(`${BASE_URL}/Invoices`, {
            params: filterNull({ ...getAuthParams(), ...options }), timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'add-color-library': async (...imagePaths) => {
        log('info', 'add-color-library', { count: imagePaths.length });
        if (imagePaths.length === 0) {
            console.error('Usage: node cli.js add-color-library <path|url> [path|url] ...');
            process.exit(1);
        }
        const resolvedUrls = await Promise.all(imagePaths.map(p => ensureUrl(p)));
        const payload = { ...getAuthParams(), imagesUrl: resolvedUrls };
        const res = await axiosRetry.post(`${BASE_URL}/AddColorLibrary`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    }
};

const [cmd, ...args] = process.argv.slice(2);

function parseArgs(rawArgs) {
    const options = {};
    const filteredArgs = [];
    let i = 0;
    while (i < rawArgs.length) {
        if (rawArgs[i].startsWith('--')) {
            const arg = rawArgs[i].slice(2);
            if (arg.includes('=')) {
                const eqIdx = arg.indexOf('=');
                const key = arg.slice(0, eqIdx);
                const val = arg.slice(eqIdx + 1);
                options[key] = val === 'true' ? true : val === 'false' ? false : val;
            } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
                const val = rawArgs[i + 1];
                options[arg] = val === 'true' ? true : val === 'false' ? false : val;
                i++;
            } else {
                options[arg] = true;
            }
        } else {
            filteredArgs.push(rawArgs[i]);
        }
        i++;
    }
    return { filteredArgs, options };
}

if (commands[cmd]) {
    const { filteredArgs, options } = parseArgs(args);
    (async () => {
        try {
            if (cmd === 'upload' || cmd === 'stack') {
                // --template is what the skills and the Python CLI use. Left in `options` it was
                // spread into the payload as an unknown `template` field and the job was created
                // without one. The positional form is still accepted for existing callers.
                /** @type {Record<string, any>} */
                const { template, templateId: templateIdFlag, ...rest } = options;
                const templateId = template ?? templateIdFlag ?? filteredArgs[1];
                if (cmd === 'upload') {
                    if (templateId == null) throw new Error('[VALIDATION_ERROR] upload requires --template <ID>');
                    if (rest.colorwayIds) rest.colorwayIds = JSON.parse(rest.colorwayIds);
                    // Integers, as documented and as the Python CLI sends them.
                    for (const k of ['markerX', 'markerY']) if (rest[k] != null) rest[k] = parseInt(rest[k], 10);
                }
                await commands[cmd](filteredArgs[0], templateId == null ? undefined : String(templateId), rest);
            } else if (cmd === 'add-color-library') {
                await commands['add-color-library'](...filteredArgs);
            } else if (cmd === 'white-glove') {
                await commands['white-glove'](filteredArgs[0], options);
            } else if (cmd === 'list-images' || cmd === 'count-images' || cmd === 'get-invoices' || cmd === 'list-products') {
                await commands[cmd](options);
            } else if (cmd === 'reject') {
                await commands.reject(filteredArgs[0], filteredArgs[1], options);
            } else if (cmd === 'status' || cmd === 'delete') {
                await commands[cmd](filteredArgs[0], options);
            } else {
                await commands[cmd](...filteredArgs);
            }
        } catch (err) {
            if (err.response) {
                const status = err.response.status;
                const data = err.response.data;
                console.error(redactSecrets(`[HTTP_${status}] ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`));
            } else if (err.code === 'ECONNABORTED') {
                console.error(`[TIMEOUT] Request timed out`);
            } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                console.error(redactSecrets(`[NETWORK_ERROR] ${err.message}`));
            } else {
                // Messages raised with their own category (e.g. [AUTH_ERROR]) keep it as-is.
                const msg = /^\[[A-Z0-9_]+\]/.test(err.message) ? err.message : `[API_ERROR] ${err.message}`;
                console.error(redactSecrets(msg));
            }
            process.exit(1);
        }
    })();
} else {
    console.log(`Pixelz Platform CLI

Usage: node cli.js <command> [args] [--options]

Commands:
  list-templates                          List retouching specification templates
  get-template <id>                       Get template details by ID
  upload <path|url> --template <id> [opts] Submit image for retouching
  white-glove <path|url> [opts]           Submit image for white-glove review
  stack <path|url> [--template <id>]      Submit image as part of a stack
  status <ticket> [--customer-id X]       Get image processing status
  list-images [--status X] [--fromDate]   List images (status: 10/new, 60/in production, 70/production finished, 80/delivered)
  count-images [--status X] [--fromDate]  Count images (accepts same status names or codes)
  list-products [--page N] [--per-page N] List product IDs with stats
  delete <ticket> [--customer-id X]       Cancel image processing
  reject <ticket> <comment> [opts]        Request correction for delivered image
  get-contact                             Get account profile and balance
  get-invoices [--fromDate] [--toDate]    Get billing statements
  add-color-library <path|url>...         Register color swatches, get colorwayIds

Upload also accepts --colorwayIds='[123,456]' for color matching with registered swatches.

Options use --key=value or --key value syntax.`);
}
