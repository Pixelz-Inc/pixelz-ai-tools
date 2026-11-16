const path = require('path');
const { UploadFile, validateId, filterNull, loadEnv, createRedactor, createLogger, createHttp, resolveLocalFile,
    AUTOMATION_UPLOAD_EXTENSIONS, AUTOMATION_MIME_TYPES, HEX_COLOR, CROP_LOCATIONS, UPLOAD_UNAVAILABLE, isUrl } =
    require(path.join(__dirname, '../../../shared/node/pixelz-common.js'));
const { fail, requireHex, flag, runCli } = require(path.join(__dirname, '../../../shared/node/pixelz-cli.js'));
loadEnv(path.resolve(__dirname, '../../../.env'));

// Overridable so tests can point at a local stub and assert the exact outgoing payload.
const AUTH_URL = process.env.PIXELZ_AUTOMATION_AUTH_URL || 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = process.env.PIXELZ_AUTOMATION_BASE_URL || 'https://automation-api.pixelz.com/v1';
// Overridable so tests can exercise the timeout path without waiting 90 s.
const REQUEST_TIMEOUT = (Number(process.env.PIXELZ_REQUEST_TIMEOUT_SECONDS) || 90) * 1000;

const redactSecrets = createRedactor({
    envKeys: ['PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET'],
    paramNames: ['client_id', 'client_secret'],
});
const log = createLogger(redactSecrets);
const { http, uploadTimeout } = createHttp({ timeout: REQUEST_TIMEOUT, redactSecrets });

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

/** Rejects a bad local file before the token exchange, so it costs no round-trip. */
function checkLocalInput(input) {
    if (!isUrl(input)) resolveLocalFile(input, AUTOMATION_UPLOAD_EXTENSIONS);
}

async function ensureUrlOrId(input, token) {
    if (!input) return null;
    if (isUrl(input)) return input;
    const { resolved, fileSize } = resolveLocalFile(input, AUTOMATION_UPLOAD_EXTENSIONS);
    const fileName = path.basename(resolved);
    log('info', 'Requesting upload URL', { fileName });
    let presignRes;
    try {
        presignRes = await http.post(`${BASE_URL}/files/request-upload-url`, { fileName }, {
            headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
        });
    } catch (/** @type {any} */ err) {
        if (err.response?.status === 403) throw new Error(UPLOAD_UNAVAILABLE);
        throw err;
    }
    const uploadUrl = presignRes.data?.url;
    if (!uploadUrl) throw new Error('Upload URL request returned an unexpected response.');
    // The allowlist keeps this a known type; octet-stream only applies under PIXELZ_UPLOAD_ANY_FILE_TYPE.
    const contentType = AUTOMATION_MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    log('info', 'Uploading file', { fileName, size: fileSize });
    await http.put(uploadUrl, new UploadFile(resolved), { headers: { 'Content-Type': contentType }, timeout: uploadTimeout(fileSize) });
    return uploadUrl;
}

function makeHeaders(token, sync = false) {
    const h = { Authorization: `Bearer ${token}` };
    if (!sync) h['Respond-Mode'] = 'async';
    return h;
}

function requireFeather(value) {
    if (value != null && value < 0) throw fail('--feather must be >= 0');
}

const isPlainObject = (/** @type {any} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (/** @type {any} */ v) => Number.isInteger(v);

/**
 * Validates MARKERS_JSON against the API's ColorMarker schema and returns the parsed markers.
 * @param {string} text
 */
function parseMarkers(text) {
    let markers;
    try {
        markers = JSON.parse(text);
    } catch {
        throw fail('MARKERS_JSON is not valid JSON');
    }
    if (!Array.isArray(markers) || markers.length === 0) throw fail('MARKERS_JSON must be a non-empty JSON array of markers');
    markers.forEach((m, i) => {
        const at = `MARKERS_JSON[${i}]`;
        if (!isPlainObject(m)) throw fail(`${at} must be an object`);
        if (!isInt(m.x_coordinate) || !isInt(m.y_coordinate)) throw fail(`${at} needs integer x_coordinate and y_coordinate`);
        const hasColor = m.swatch_color_code != null;
        const hasImage = m.swatch_image != null;
        if (hasColor === hasImage) throw fail(`${at} needs exactly one of swatch_color_code or swatch_image`);
        if (hasColor && !(typeof m.swatch_color_code === 'string' && HEX_COLOR.test(m.swatch_color_code))) {
            throw fail(`${at}.swatch_color_code must be a hex colour like #FF5733`);
        }
        if (hasImage) {
            const s = m.swatch_image;
            if (!isPlainObject(s) || typeof s.swatch_image_url !== 'string' || !s.swatch_image_url
                || !isInt(s.x_coordinate) || !isInt(s.y_coordinate)) {
                throw fail(`${at}.swatch_image needs swatch_image_url and integer x_coordinate and y_coordinate`);
            }
        }
    });
    return markers;
}

/** @typedef {Record<string, any>} Options */

const commands = {
    'remove-bg': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        requireHex('--color', options.color);
        requireFeather(options.feather);
        // The API takes exactly one of the two ("do not set both, and do not leave both unset").
        const transparent = options.transparent !== undefined ? options.transparent === 'true' : !options.color;
        if (options.color && transparent) throw fail('--color and --transparent true cannot be used together');
        if (!options.color && !transparent) throw fail('--transparent false requires --color');
        checkLocalInput(input);
        log('info', 'remove-bg');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            background_color: options.color,
            transparent_background: transparent,
            feather_width: options.feather,
            trimap_url: options.trimap,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/remove-background`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'color-match': async (/** @type {string[]} */ [input, markersJson], /** @type {Options} */ options) => {
        const markers = parseMarkers(markersJson);
        checkLocalInput(input);
        log('info', 'color-match');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            color_markers: markers,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/color-matching`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'create-mask': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        requireFeather(options.feather);
        checkLocalInput(input);
        log('info', 'create-mask');
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            feather_width: options.feather,
            trimap_url: options.trimap,
            callback_url: options.callback
        });
        const res = await http.post(`${BASE_URL}/images/create-mask`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'create-trimap': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        checkLocalInput(input);
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
    'model-crop': async (/** @type {string[]} */ [input], /** @type {Options} */ options) => {
        if (options.top == null && options.bottom == null) throw fail('model-crop requires at least one of --top or --bottom');
        for (const [flag, value] of [['--top', options.top], ['--bottom', options.bottom]]) {
            if (value != null && !CROP_LOCATIONS.includes(value)) throw fail(`${flag} must be one of: ${CROP_LOCATIONS.join(', ')}`);
        }
        checkLocalInput(input);
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
    'status': async (/** @type {string[]} */ [jobId]) => {
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

// --- Command-line flag definitions (the parser itself is in shared/node/pixelz-cli.js) ---------

const SYNC_AND_CALLBACK = { ...flag('string', 'callback'), ...flag('bool', 'sync') };

/** @type {Record<string, import('../../../shared/node/pixelz-cli.js').CommandSpec>} */
const SPECS = {
    'remove-bg': {
        positionals: ['input'],
        flags: {
            ...flag('string', 'color'), ...flag('true-false', 'transparent'), ...flag('float', 'feather'),
            ...flag('string', 'trimap'), ...SYNC_AND_CALLBACK,
        },
    },
    'color-match': { positionals: ['input', 'markers'], flags: SYNC_AND_CALLBACK },
    'create-mask': {
        positionals: ['input'],
        flags: { ...flag('float', 'feather'), ...flag('string', 'trimap'), ...SYNC_AND_CALLBACK },
    },
    'create-trimap': { positionals: ['input'], flags: SYNC_AND_CALLBACK },
    'model-crop': {
        positionals: ['input'],
        flags: { ...flag('string', 'top'), ...flag('string', 'bottom'), ...SYNC_AND_CALLBACK },
    },
    'status': { positionals: ['job_id'], flags: {} },
    'get-key': { positionals: [], flags: {} },
};

const USAGE = `Pixelz Automation CLI

Usage: node cli.js <command> <path|url> [args] [--options]

Commands:
  remove-bg <path|url> [--color X] [--transparent true|false] [--feather N] [--trimap URL] [--callback URL] [--sync]
      AI-powered background removal (--color #RRGGBB or --transparent true, not both)

  color-match <path|url> <markersJSON> [--callback URL] [--sync]
      AI-powered color correction

  create-mask <path|url> [--feather N] [--trimap URL] [--callback URL] [--sync]
      Generate greyscale silhouette mask

  create-trimap <path|url> [--callback URL] [--sync]
      Generate trimap for complex edges

  model-crop <path|url> [--top LOCATION] [--bottom LOCATION] [--callback URL] [--sync]
      Crop model photo using anatomical landmarks (at least one of --top / --bottom)

  status <jobId>
      Poll async job status

  get-key
      Get webhook verification public key

Options use --key=value or --key value syntax. A flag that takes a value must be given one;
--sync takes none.`;

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
