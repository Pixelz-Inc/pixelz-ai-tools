const path = require('path');
const fs = require('fs');
// Node's built-in .env loader (stable since 22.21). Like dotenv it never overrides variables
// that are already set, and unlike dotenv it prints nothing to stdout (which carries JSON).
// A missing file is fine: the credentials may come from the environment instead.
const ENV_FILE = process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../.env');
if (fs.statSync(ENV_FILE, { throwIfNoEntry: false })?.isFile()) process.loadEnvFile(ENV_FILE);

// Overridable so tests can point at a local stub and assert the exact outgoing params.
const BASE_URL = process.env.PIXELZ_PLATFORM_BASE_URL || 'https://api.pixelz.com/REST.svc/JSON';
// Overridable so tests can exercise the timeout path without waiting 90 s.
const REQUEST_TIMEOUT = (Number(process.env.PIXELZ_REQUEST_TIMEOUT_SECONDS) || 90) * 1000;
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
// JSON in/out, a timeout, errors carrying .response / .code, and retries. No dependency, so the
// CLI runs with nothing installed.
class UploadFile {
    /** @param {string} filePath */
    constructor(filePath) { this.path = filePath; }
}

/** The OS error code behind a failed fetch, e.g. ECONNREFUSED; ECONNABORTED for our timeout. */
function networkCode(err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'ECONNABORTED';
    // fetch reports socket failures as TypeError('fetch failed') with the code on .cause, or on
    // .cause.errors[] when every address refused (seen on Windows for ECONNREFUSED).
    return err.cause?.code ?? err.cause?.errors?.find(e => e.code)?.code;
}

async function backoff(attempt, retryAfter) {
    // Retry-After may be empty or an HTTP-date rather than seconds; those fall back to backoff.
    const secs = retryAfter == null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
    const delay = Number.isFinite(secs)
        ? Math.min(Math.max(secs, 0), RETRY_AFTER_MAX_SECONDS) * 1000
        : Math.min(1000 * 2 ** attempt, 30000);
    await new Promise(r => setTimeout(r, delay));
}

/**
 * @param {string} method
 * @param {string} url
 * @param {{ params?: Record<string, any>, body?: any, headers?: Record<string, string>, timeout?: number }} [opts]
 */
async function request(method, url, { params, body, headers = {}, timeout = REQUEST_TIMEOUT } = {}) {
    if (params) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(filterNull(params));
    for (let attempt = 0; ; attempt++) {
        const retryable = RETRY_METHODS.has(method) && attempt < MAX_RETRIES;
        /** @type {Record<string, string>} */
        const h = { ...headers };
        let payload = body;
        if (body instanceof UploadFile) {
            // A Blob backed by the file: streamed from disk with the Content-Length S3 requires (a
            // stream body would go out chunked), and safe to send again on a retry.
            payload = await fs.openAsBlob(body.path);
        } else if (body !== undefined && !(body instanceof URLSearchParams)) {
            payload = JSON.stringify(body);
            h['Content-Type'] = h['Content-Type'] || 'application/json';
        }
        let res, text;
        try {
            res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout) });
            // Inside the try and under the same signal: a stall mid-body is a timeout too.
            text = await res.text();
        } catch (e) {
            const code = networkCode(e);
            if (retryable && RETRY_CODES.has(code)) { await backoff(attempt, null); continue; }
            const timedOut = TIMEOUT_CODES.has(code);
            // Deliberately no URL in the message: Platform credentials travel in the query string.
            throw Object.assign(new Error(code ? `${e.message} (${code})` : e.message),
                { code: timedOut ? 'ECONNABORTED' : code, network: !timedOut && code !== 'ERR_INVALID_URL' });
        }
        let data = text, isJson = true;
        try { data = text ? JSON.parse(text) : ''; } catch { isJson = false; }
        if (res.ok) {
            // A 2xx that is not JSON is a proxy or login page, not an API answer (Python fails too).
            if (!isJson) throw new Error(`[API_ERROR] Expected a JSON response (HTTP ${res.status}), got: ${text.slice(0, 100)}`);
            return { status: res.status, data };
        }
        if (retryable && RETRY_STATUS.has(res.status)) {
            await backoff(attempt, res.headers.get('retry-after'));
            continue;
        }
        throw Object.assign(new Error(`Request failed with status code ${res.status}`), { response: { status: res.status, data } });
    }
}

const http = {
    get: (url, opts = {}) => request('GET', url, opts),
    post: (url, body, opts = {}) => request('POST', url, { ...opts, body }),
    put: (url, body, opts = {}) => request('PUT', url, { ...opts, body }),
    delete: (url, opts = {}) => request('DELETE', url, opts),
};

// fetch's timeout covers the whole request, where axios's was socket inactivity, so an upload's
// limit must include the transfer itself. 32 KB/s (~256 kbit/s) keeps slow uplinks working.
const uploadTimeout = size => REQUEST_TIMEOUT + Math.ceil(size / (32 * 1024)) * 1000;

function redactSecrets(text) {
    let s = String(text);
    for (const key of ['PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL']) {
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
    s = s.replace(/(contactAPIkey|contactEmail)=[^&\s'"]*/gi, '$1=<REDACTED>');
    return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>');
}

const logFile = process.env.PIXELZ_LOG_FILE;
function log(level, message, data) {
    if (!logFile) return;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    // Redacted here, not at call sites: error text can carry a credentialed request URL.
    // Synchronous: the CLI calls process.exit() on failure, which would drop a pending async write.
    try {
        fs.appendFileSync(logFile, redactSecrets(entry));
    } catch (err) {
        process.stderr.write('Log write failed: ' + err.message + '\n');
    }
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
    const presignRes = await http.post(`${BASE_URL}/RequestPresignUrls`, {
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
    log('info', 'Uploading file to S3', { fileName, size: fileSize });
    await http.put(UploadUrl, new UploadFile(resolved), {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: uploadTimeout(fileSize)
    });
    return DownloadUrl;
}

const commands = {
    'list-templates': async () => {
        log('info', 'list-templates');
        const res = await http.get(`${BASE_URL}/Templates`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-template': async (id) => {
        validateId(id, 'templateId');
        log('info', 'get-template', { id });
        const res = await http.get(`${BASE_URL}/Template/${id}`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
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
        const res = await http.post(`${BASE_URL}/Image`, payload, { timeout: REQUEST_TIMEOUT });
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
        const res = await http.post(`${BASE_URL}/WhiteGloveService`, payload, { timeout: REQUEST_TIMEOUT });
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
        const res = await http.post(`${BASE_URL}/StackImage`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'status': async (ticket, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'status', { ticket });
        const params = filterNull({ ...getAuthParams(), customerImageId: pickCustomerId(options) });
        const res = await http.get(`${BASE_URL}/Image/${ticket}`, {
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
        const res = await http.get(`${BASE_URL}/Images`, {
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
        const res = await http.get(`${BASE_URL}/Images/Count`, {
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
        const res = await http.get(`${BASE_URL}/ProductIds`, {
            params: filterNull({ ...getAuthParams(), page: page ? parseInt(page, 10) : undefined, productIdsPerPage: perPage ? parseInt(perPage, 10) : undefined }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'delete': async (ticket, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'delete', { ticket });
        const res = await http.delete(`${BASE_URL}/Image/${ticket}`, {
            body: filterNull({ ...getAuthParams(), customerImageId: pickCustomerId(options) }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'reject': async (ticket, comment, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'reject', { ticket });
        const { 'customer-id': _cid, customerImageId: _cii, ...rest } = options;
        const res = await http.put(`${BASE_URL}/Image/Reject/${ticket}`, filterNull({
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
        const res = await http.get(`${BASE_URL}/Contact`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-invoices': async (options = {}) => {
        log('info', 'get-invoices', options);
        if (options.page) options.page = parseInt(options.page, 10);
        const res = await http.get(`${BASE_URL}/Invoices`, {
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
        const res = await http.post(`${BASE_URL}/AddColorLibrary`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    }
};

const [cmd, ...args] = process.argv.slice(2);

// The flags each command accepts, mirroring the Python CLI's argparse definitions. Anything else
// is rejected: unknown flags used to be spread into the request, so a typo like --commnt created
// a billable job without the comment, and a stray --contactAPIkey could override credentials.
const IMG = ['imageURL2', 'imageURL3', 'imageURL4', 'imageURL5', 'colorReferenceFileURL', 'imageCallbackURL',
    'customerImageId', 'productId', 'customerFolder'];
const ALLOWED_FLAGS = {
    'list-templates': [], 'get-template': [], 'get-contact': [], 'add-color-library': [],
    'upload': ['template', 'templateId', ...IMG, 'imageDeadlineDateTimeUTC', 'comment', 'markupImageUrl',
        'swatchImageURL', 'swatchColorCode', 'markerX', 'markerY', 'outputFileName', 'customerImageColorID', 'colorwayIds'],
    'white-glove': [...IMG, 'comment', 'markupImageUrl'],
    'stack': ['template', 'templateId', ...IMG, 'imageDeadlineDateTimeUTC'],
    'status': ['customer-id', 'customerImageId'],
    'list-images': ['status', 'imageStatus', 'excludeImageStatus', 'productId', 'fromDate', 'toDate', 'page',
        'imagesPerPage', 'sortBy', 'isDescending'],
    'count-images': ['status', 'imageStatus', 'fromDate', 'toDate'],
    'list-products': ['page', 'per-page', 'perPage'],
    'delete': ['customer-id', 'customerImageId'],
    'reject': ['customer-id', 'customerImageId', 'markupImageUrl'],
    'get-invoices': ['fromDate', 'toDate', 'page', 'returnUrl'],
};
// Flags that take no value, so `--flag <positional>` must not swallow the positional.
const BOOLEAN_FLAGS = new Set();

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
            } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')
                && !(BOOLEAN_FLAGS.has(arg) && !['true', 'false'].includes(rawArgs[i + 1]))) {
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
            const unknown = Object.keys(options).filter(k => !ALLOWED_FLAGS[cmd].includes(k));
            if (unknown.length) {
                throw new Error(`[VALIDATION_ERROR] unknown option(s) for ${cmd}: ${unknown.map(k => '--' + k).join(', ')}`);
            }
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
