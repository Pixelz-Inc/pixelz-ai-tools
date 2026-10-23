const path = require('path');
const fs = require('fs');
// Node's built-in .env loader (stable since 22.21). Like dotenv it never overrides variables
// that are already set, and unlike dotenv it prints nothing to stdout (which carries JSON).
// A missing file is fine: the credentials may come from the environment instead.
const ENV_FILE = process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../.env');
if (fs.statSync(ENV_FILE, { throwIfNoEntry: false })?.isFile()) process.loadEnvFile(ENV_FILE);

// Overridable so tests can point at a local stub and assert the exact outgoing payload.
const AUTH_URL = process.env.PIXELZ_AUTOMATION_AUTH_URL || 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = process.env.PIXELZ_AUTOMATION_BASE_URL || 'https://automation-api.pixelz.com/v1';
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

const tokenCache = { token: null, expiresAt: 0 };
let tokenPromise = null;

async function getAccessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }
    if (!tokenPromise) {
        tokenPromise = (async () => {
            try {
                const clientId = process.env.PIXELZ_AUTOMATION_CLIENT_ID;
                const clientSecret = process.env.PIXELZ_AUTOMATION_CLIENT_SECRET;

                if (!clientId || !clientSecret) {
                    console.error(`[AUTH_ERROR] Missing Automation API credentials.
Required: PIXELZ_AUTOMATION_CLIENT_ID and PIXELZ_AUTOMATION_CLIENT_SECRET in .env file.`);
                    process.exit(1);
                }

                const params = new URLSearchParams();
                params.append('grant_type', 'client_credentials');
                params.append('client_id', clientId);
                params.append('client_secret', clientSecret);
                log('info', 'Requesting new OAuth token');
                const res = await http.post(AUTH_URL, params, { timeout: REQUEST_TIMEOUT });
                tokenCache.token = res.data.access_token;
                tokenCache.expiresAt = Date.now() + ((res.data.expires_in || 3600) - 60) * 1000;
                return tokenCache.token;
            } finally {
                tokenPromise = null;
            }
        })();
    }
    return tokenPromise;
}

const MIME_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp'
};

async function ensureUrlOrId(input, token) {
    if (!input) return null;
    if (input.startsWith('http://') || input.startsWith('https://')) return input;
    if (!fs.existsSync(input)) throw new Error(`Local file not found: ${input}`);
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Not a regular file: ${input}`);
    const fileSize = fs.statSync(resolved).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const fileName = path.basename(resolved);
    log('info', 'Requesting upload URL', { fileName });
    const presignRes = await http.post(`${BASE_URL}/files/request-upload-url`, { fileName }, {
        headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
    });
    const uploadUrl = presignRes.data.url;
    const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    log('info', 'Uploading file', { fileName, size: fileSize });
    await http.put(uploadUrl, new UploadFile(resolved), { headers: { 'Content-Type': contentType }, timeout: uploadTimeout(fileSize) });
    return uploadUrl;
}

function makeHeaders(token, sync = false) {
    const h = { Authorization: `Bearer ${token}` };
    if (!sync) h['Respond-Mode'] = 'async';
    return h;
}

const commands = {
    'remove-bg': async (input, options = {}) => {
        log('info', 'remove-bg');
        // The API takes exactly one of the two ("do not set both, and do not leave both unset").
        const transparent = options.transparent !== undefined ? String(options.transparent) === 'true' : !options.color;
        if (options.color && transparent) throw new Error('[VALIDATION_ERROR] --color and --transparent true cannot be used together');
        if (!options.color && !transparent) throw new Error('[VALIDATION_ERROR] --transparent false requires --color');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            background_color: options.color,
            transparent_background: transparent,
            feather_width: options.feather ? parseFloat(options.feather) : undefined,
            trimap_url: options.trimap,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/remove-background`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'color-match': async (input, markersJson, options = {}) => {
        log('info', 'color-match');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            color_markers: JSON.parse(markersJson),
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/color-matching`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'create-mask': async (input, options = {}) => {
        log('info', 'create-mask');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            feather_width: options.feather ? parseFloat(options.feather) : undefined,
            trimap_url: options.trimap,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/create-mask`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'create-trimap': async (input, options = {}) => {
        log('info', 'create-trimap');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/create-trimap`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'model-crop': async (input, options = {}) => {
        log('info', 'model-crop');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            top_crop_location: options.top,
            bottom_crop_location: options.bottom,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/model-crop`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'status': async (jobId) => {
        validateId(jobId, 'jobId');
        log('info', 'status', { jobId });
        const token = await getAccessToken();
        const res = await http.get(`${BASE_URL}/images/jobs/${jobId}/status`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-key': async () => {
        log('info', 'get-key');
        const token = await getAccessToken();
        const res = await http.get(`${BASE_URL}/webhook/public-keys`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    }
};

const [cmd, ...args] = process.argv.slice(2);

// The flags each command accepts, mirroring the Python CLI's argparse definitions. Anything else
// is rejected: an unknown flag (e.g. the typo --feathr) used to be dropped silently.
const ALLOWED_FLAGS = {
    'remove-bg': ['color', 'transparent', 'feather', 'trimap', 'callback', 'sync'],
    'color-match': ['callback', 'sync'],
    'create-mask': ['feather', 'trimap', 'callback', 'sync'],
    'create-trimap': ['callback', 'sync'],
    'model-crop': ['top', 'bottom', 'callback', 'sync'],
    'status': [], 'get-key': [],
};
// Flags that take no value, so `--sync <positional>` must not swallow the positional.
const BOOLEAN_FLAGS = new Set(['sync']);

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
            if (cmd === 'color-match') {
                await commands['color-match'](filteredArgs[0], filteredArgs[1], options);
            } else if (cmd === 'status' || cmd === 'get-key') {
                await commands[cmd](...filteredArgs);
            } else {
                await commands[cmd](filteredArgs[0], options);
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
    console.log(`Pixelz Automation CLI

Usage: node cli.js <command> <path|url> [args] [--options]

Commands:
  remove-bg <path|url> [--color X] [--transparent] [--feather N] [--trimap URL] [--callback URL] [--sync]
      AI-powered background removal

  color-match <path|url> <markersJSON> [--callback URL] [--sync]
      AI-powered color correction

  create-mask <path|url> [--feather N] [--trimap URL] [--callback URL] [--sync]
      Generate greyscale silhouette mask

  create-trimap <path|url> [--callback URL] [--sync]
      Generate trimap for complex edges

  model-crop <path|url> [--top LOCATION] [--bottom LOCATION] [--callback URL] [--sync]
      Crop model photo using anatomical landmarks

  status <jobId>
      Poll async job status

  get-key
      Get webhook verification public key

Options use --key=value or --key value syntax.`);
}
