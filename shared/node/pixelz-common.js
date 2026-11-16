// HTTP, retry, redaction, logging and upload plumbing shared by the Node CLIs and MCP servers.
// Node built-ins only: the CLIs must run with nothing installed, so never add a dependency here.
// Hand-written types live in pixelz-common.d.ts for the TypeScript servers; keep the two in step.
const fs = require('fs');
const path = require('path');

/** @typedef {{ params?: Record<string, any>, body?: any, headers?: Record<string, string>, timeout?: number }} RequestOptions */

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

/**
 * Loads the .env file into process.env.
 * Node's built-in .env loader (stable since 22.21). Like dotenv it never overrides variables
 * that are already set, and unlike dotenv it prints nothing to stdout (which carries JSON).
 * A missing file is fine: the credentials may come from the environment instead.
 * @param {string} defaultEnvFile used when PIXELZ_DOTENV_PATH is not set
 */
function loadEnv(defaultEnvFile) {
    const envFile = process.env.PIXELZ_DOTENV_PATH || defaultEnvFile;
    if (fs.statSync(envFile, { throwIfNoEntry: false })?.isFile()) process.loadEnvFile(envFile);
}

// HTTP via Node's built-in fetch, shaped like the slice of axios this code used to rely on:
// JSON in/out, a timeout, errors carrying .response / .code, and retries. No dependency, so the
// CLI runs with nothing installed.
class UploadFile {
    /** @param {string} filePath */
    constructor(filePath) { this.path = filePath; }
}

/**
 * The OS error code behind a failed fetch, e.g. ECONNREFUSED; ECONNABORTED for our timeout.
 * @param {any} err
 * @returns {string | undefined}
 */
function networkCode(err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'ECONNABORTED';
    // fetch reports socket failures as TypeError('fetch failed') with the code on .cause, or on
    // .cause.errors[] when every address refused (seen on Windows for ECONNREFUSED).
    return err.cause?.code ?? err.cause?.errors?.find((/** @type {any} */ e) => e.code)?.code;
}

/**
 * @param {number} attempt
 * @param {string | null} retryAfter
 */
async function backoff(attempt, retryAfter) {
    // Retry-After may be empty or an HTTP-date rather than seconds; those fall back to backoff.
    const secs = retryAfter == null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
    const delay = Number.isFinite(secs)
        ? Math.min(Math.max(secs, 0), RETRY_AFTER_MAX_SECONDS) * 1000
        : Math.min(1000 * 2 ** attempt, 30000);
    await new Promise(r => setTimeout(r, delay));
}

/** @param {Record<string, any>} obj */
function filterNull(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));
}

/**
 * @param {string} value
 * @param {string} name
 */
function validateId(value, name) {
    if (typeof value !== 'string' || value === '') throw new Error(`[VALIDATION_ERROR] ${name} is required`);
    if (!/^[a-zA-Z0-9_\-]+$/.test(value)) {
        throw new Error(`[VALIDATION_ERROR] Invalid ${name}: contains unexpected characters`);
    }
}

/**
 * Builds the redactor for one API: which env vars hold its credentials and which query/form
 * param names carry them.
 * @param {{ envKeys: string[], paramNames: string[] }} cfg
 * @returns {(text: any) => string}
 */
function createRedactor({ envKeys, paramNames }) {
    const paramPattern = new RegExp(`(${paramNames.join('|')})=[^&\\s'"]*`, 'gi');
    return function redactSecrets(text) {
        let s = String(text);
        for (const key of envKeys) {
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
        s = s.replace(paramPattern, '$1=<REDACTED>');
        return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>');
    };
}

/**
 * Builds log(): appends to PIXELZ_LOG_FILE (read when this is called) if set, else does nothing.
 * @param {(text: any) => string} redactSecrets
 * @returns {(level: string, message: string, data?: any) => void}
 */
function createLogger(redactSecrets) {
    const logFile = process.env.PIXELZ_LOG_FILE;
    return function log(level, message, data) {
        if (!logFile) return;
        const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
        // Redacted here, not at call sites: error text can carry a credentialed request URL.
        // Synchronous: the CLI calls process.exit() on failure, which would drop a pending async write.
        try {
            fs.appendFileSync(logFile, redactSecrets(entry));
        } catch (/** @type {any} */ err) {
            process.stderr.write('Log write failed: ' + err.message + '\n');
        }
    };
}

/**
 * Builds the HTTP client for one API.
 * @param {{ timeout: number, redactSecrets: (text: any) => string }} cfg timeout in ms
 */
function createHttp({ timeout: defaultTimeout, redactSecrets }) {
    /**
     * @param {string} method
     * @param {string} url
     * @param {RequestOptions} [opts]
     * @returns {Promise<{ status: number, data: any }>}
     */
    async function request(method, url, { params, body, headers = {}, timeout = defaultTimeout } = {}) {
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
            } catch (/** @type {any} */ e) {
                const code = networkCode(e);
                if (retryable && RETRY_CODES.has(code)) { await backoff(attempt, null); continue; }
                const timedOut = TIMEOUT_CODES.has(code);
                // Deliberately no URL in the message: Platform credentials travel in the query string.
                // timeoutMs: uploads use a longer, size-based limit, so callers report this figure.
                throw Object.assign(new Error(code ? `${e.message} (${code})` : e.message),
                    { code: timedOut ? 'ECONNABORTED' : code, network: !timedOut && code !== 'ERR_INVALID_URL', timeoutMs: timeout });
            }
            let data = text, isJson = true;
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

    const http = {
        /** @param {string} url @param {RequestOptions} [opts] */
        get: (url, opts = {}) => request('GET', url, opts),
        /** @param {string} url @param {any} body @param {RequestOptions} [opts] */
        post: (url, body, opts = {}) => request('POST', url, { ...opts, body }),
        /** @param {string} url @param {any} body @param {RequestOptions} [opts] */
        put: (url, body, opts = {}) => request('PUT', url, { ...opts, body }),
        /** @param {string} url @param {RequestOptions} [opts] */
        delete: (url, opts = {}) => request('DELETE', url, opts),
    };

    // fetch's timeout covers the whole request, where axios's was socket inactivity, so an upload's
    // limit must include the transfer itself. 32 KB/s (~256 kbit/s) keeps slow uplinks working.
    /** @param {number} size bytes */
    const uploadTimeout = size => defaultTimeout + Math.ceil(size / (32 * 1024)) * 1000;

    return { request, http, uploadTimeout };
}

// The Automation API accepts only these image types; the keys double as the upload allowlist.
const AUTOMATION_MIME_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const AUTOMATION_UPLOAD_EXTENSIONS = Object.keys(AUTOMATION_MIME_TYPES);
// A best guess at what the Platform API retouches; PIXELZ_UPLOAD_ANY_FILE_TYPE=true bypasses it if wrong.
const PLATFORM_UPLOAD_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.psd', '.psb', '.gif', '.bmp', '.heic', '.heif',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2',
];

/**
 * Validates a local upload source and returns its resolved path and size.
 * The extension allowlist is checked before any network call so an agent cannot ship .env or key
 * files to a third-party bucket.
 * @param {string} input
 * @param {readonly string[]} allowedExtensions
 * @returns {{ resolved: string, fileSize: number }}
 */
function resolveLocalFile(input, allowedExtensions) {
    if (!fs.existsSync(input)) throw new Error(`[VALIDATION_ERROR] Local file not found: ${input}`);
    const resolved = fs.realpathSync(input);
    if (!fs.statSync(resolved).isFile()) throw new Error(`[VALIDATION_ERROR] Not a regular file: ${input}`);
    if (process.env.PIXELZ_UPLOAD_ANY_FILE_TYPE !== 'true') {
        // The resolved path: that is the file (and name) actually uploaded, so a symlink cannot launder an extension.
        const ext = path.extname(resolved).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            throw new Error(`[VALIDATION_ERROR] Unsupported file type "${ext}" for upload. Allowed: ${allowedExtensions.join(', ')}.`);
        }
    }
    const fileSize = fs.statSync(resolved).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`[VALIDATION_ERROR] File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    return { resolved, fileSize };
}

/** @param {string} input */
const isUrl = input => input.startsWith('http://') || input.startsWith('https://');

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

// The 17 values of the API's top_crop_location / bottom_crop_location enum.
const CROP_LOCATIONS = ['eye_higher', 'below_eye', 'btw_eye_and_nose', 'below_nose',
    'between_nose_and_mouth', 'below_mouth', 'below_chin', 'chest',
    'at_elbow_higher', 'at_elbow_lower', 'waist', 'below_buttock',
    'main_body_axis', 'mid_thigh', 'above_knee', 'at_knee', 'below_knee'];

const UPLOAD_UNAVAILABLE = '[UPLOAD_UNAVAILABLE] HTTP 403: the account may not be enabled for direct file uploads ' +
    '(off by default on the Automation API). Provide a publicly accessible image URL instead of a local file path.';

const STATUS_ALIASES = {
    'new': '10', 'in production': '60', 'production finished': '70', 'delivered': '80'
};

/** @param {any} value */
function resolveStatus(value) {
    if (value == null) return value;
    const lower = String(value).toLowerCase();
    // hasOwn: a plain lookup would return Object.prototype members for inputs like "constructor".
    return Object.hasOwn(STATUS_ALIASES, lower) ? STATUS_ALIASES[/** @type {keyof typeof STATUS_ALIASES} */ (lower)] : value;
}

/** @param {any} data */
function checkApiError(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const code = data.ErrorCode;
        if (code !== undefined && code !== 'NoError' && code !== 0) {
            throw new Error(`[API_ERROR] ${code}: ${data.Message || ''}`);
        }
    }
}

/**
 * Validates a Platform RequestPresignUrls response and returns its first upload target.
 * @param {any} presignData
 * @returns {{ UploadUrl: string, DownloadUrl: string }}
 */
function parsePlatformPresign(presignData) {
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
    return { UploadUrl, DownloadUrl };
}

/**
 * The repo-root package.json is the single version source; a missing file must not stop the server.
 * @param {string} packageJsonPath
 */
function readPackageVersion(packageJsonPath) {
    try {
        return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

// Shorthand-only on purpose: cjs-module-lexer needs it to expose these as named ESM imports.
module.exports = {
    MAX_FILE_SIZE, AUTOMATION_MIME_TYPES, AUTOMATION_UPLOAD_EXTENSIONS, PLATFORM_UPLOAD_EXTENSIONS,
    HEX_COLOR, CROP_LOCATIONS, UPLOAD_UNAVAILABLE, STATUS_ALIASES,
    UploadFile, networkCode, backoff, filterNull, validateId, isUrl, resolveStatus, checkApiError, parsePlatformPresign, readPackageVersion,
    loadEnv, createRedactor, createLogger, createHttp, resolveLocalFile,
};
