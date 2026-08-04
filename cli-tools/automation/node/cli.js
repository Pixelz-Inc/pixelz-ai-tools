const axios = require('axios');
const path = require('path');
const fs = require('fs');
// quiet: dotenv >=17 prints an 'injected env' banner to STDOUT by default, which
// corrupts the CLI's JSON output.
require('dotenv').config({ quiet: true, path: process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../.env') });

const AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = 'https://automation-api.pixelz.com/v1';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_RETRIES = 3;
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const axiosRetry = axios.create();
axiosRetry.interceptors.response.use(undefined, async (error) => {
    const config = error.config;
    if (!config) throw error;
    config.__retryCount = config.__retryCount || 0;
    const status = error.response?.status;
    const isRetryable = RETRY_STATUS.has(status) || ['ECONNRESET', 'ETIMEDOUT'].includes(error.code);
    if (!isRetryable || config.__retryCount >= MAX_RETRIES) throw error;
    config.__retryCount++;
    const retryAfter = error.response?.headers?.['retry-after'];
    const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(1000 * 2 ** (config.__retryCount - 1), 30000);
    await new Promise(r => setTimeout(r, delay));
    return axiosRetry(config);
});

function redactSecrets(text) {
    let s = String(text);
    for (const key of ['PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET']) {
        const val = process.env[key];
        if (val) s = s.replaceAll(val, '<REDACTED>');
    }
    return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>');
}

const logFile = process.env.PIXELZ_LOG_FILE;
function log(level, message, data) {
    if (!logFile) return;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    fs.appendFile(logFile, entry, (err) => { if (err) process.stderr.write('Log write failed: ' + err.message + '\n'); });
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
                const res = await axiosRetry.post(AUTH_URL, params, { timeout: REQUEST_TIMEOUT });
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
    const presignRes = await axiosRetry.post(`${BASE_URL}/files/request-upload-url`, { fileName }, {
        headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
    });
    const uploadUrl = presignRes.data.url;
    const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    const fileStream = fs.createReadStream(resolved);
    log('info', 'Uploading file', { fileName, size: fileSize });
    await axiosRetry.put(uploadUrl, fileStream, { headers: { 'Content-Type': contentType, 'Content-Length': String(fileSize) }, timeout: REQUEST_TIMEOUT, maxContentLength: Infinity, maxBodyLength: Infinity });
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
        const token = await getAccessToken();
        const urlOrId = await ensureUrlOrId(input, token);
        const payload = filterNull({
            image_url: urlOrId,
            background_color: options.color,
            transparent_background: options.transparent !== undefined ? options.transparent : !options.color,
            feather_width: options.feather ? parseFloat(options.feather) : undefined,
            trimap_url: options.trimap,
            callback_url: options.callback
        });
        const res = await axiosRetry.post(`${BASE_URL}/images/remove-background`, payload, {
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
        const res = await axiosRetry.post(`${BASE_URL}/images/color-matching`, payload, {
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
        const res = await axiosRetry.post(`${BASE_URL}/images/create-mask`, payload, {
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
        const res = await axiosRetry.post(`${BASE_URL}/images/create-trimap`, payload, {
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
        const res = await axiosRetry.post(`${BASE_URL}/images/model-crop`, payload, {
            headers: makeHeaders(token, options.sync), timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'status': async (jobId) => {
        validateId(jobId, 'jobId');
        log('info', 'status', { jobId });
        const token = await getAccessToken();
        const res = await axiosRetry.get(`${BASE_URL}/images/jobs/${jobId}/status`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
        });
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-key': async () => {
        log('info', 'get-key');
        const token = await getAccessToken();
        const res = await axiosRetry.get(`${BASE_URL}/webhook/public-keys`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT
        });
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
            if (cmd === 'color-match') {
                await commands['color-match'](filteredArgs[0], filteredArgs[1], options);
            } else if (cmd === 'status' || cmd === 'get-key') {
                await commands[cmd](...filteredArgs);
            } else {
                await commands[cmd](filteredArgs[0], options);
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
                console.error(redactSecrets(`[API_ERROR] ${err.message}`));
            }
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
