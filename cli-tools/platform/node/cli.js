const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: process.env.PIXELZ_DOTENV_PATH || path.resolve(__dirname, '../../../.env') });

const BASE_URL = 'https://api.pixelz.com/REST.svc/JSON';
const REQUEST_TIMEOUT = 90000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function redactSecrets(text) {
    let s = String(text);
    for (const key of ['PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL']) {
        const val = process.env[key];
        if (val) s = s.replaceAll(val, '<REDACTED>');
    }
    return s.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>');
}

const logFile = process.env.PIXELZ_LOG_FILE;
function log(level, message, data) {
    if (!logFile) return;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;
    fs.appendFile(logFile, entry, () => {});
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
    const fileSize = fs.statSync(input).size;
    if (fileSize > MAX_FILE_SIZE) throw new Error(`File too large (${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum allowed size is 2 GB.`);
    const auth = getAuthParams();
    const fileName = path.basename(input);
    log('info', 'Requesting presigned URL', { fileName });
    const presignRes = await axios.post(`${BASE_URL}/RequestPresignUrls`, {
        ...auth,
        imageNames: [fileName]
    }, { timeout: REQUEST_TIMEOUT });
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
    await axios.put(UploadUrl, fileStream, {
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
        const res = await axios.get(`${BASE_URL}/Templates`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-template': async (id) => {
        validateId(id, 'templateId');
        log('info', 'get-template', { id });
        const res = await axios.get(`${BASE_URL}/Template/${id}`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
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
        const res = await axios.post(`${BASE_URL}/Image`, payload, { timeout: REQUEST_TIMEOUT });
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
        const res = await axios.post(`${BASE_URL}/WhiteGloveService`, payload, { timeout: REQUEST_TIMEOUT });
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
        const res = await axios.post(`${BASE_URL}/StackImage`, payload, { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'status': async (ticket, customerId) => {
        validateId(ticket, 'imageTicket');
        log('info', 'status', { ticket });
        const params = filterNull({ ...getAuthParams(), customerImageId: customerId });
        const res = await axios.get(`${BASE_URL}/Image/${ticket}`, {
            params, timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'list-images': async (options = {}) => {
        log('info', 'list-images', options);
        if (options.page) options.page = parseInt(options.page, 10);
        if (options.imagesPerPage) options.imagesPerPage = parseInt(options.imagesPerPage, 10);
        if (options.imageStatus) options.imageStatus = resolveStatus(options.imageStatus);
        if (options.excludeImageStatus) options.excludeImageStatus = resolveStatus(options.excludeImageStatus);
        const res = await axios.get(`${BASE_URL}/Images`, {
            params: filterNull({ ...getAuthParams(), ...options }), timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'count-images': async (options = {}) => {
        log('info', 'count-images', options);
        if (options.imageStatus) options.imageStatus = resolveStatus(options.imageStatus);
        const res = await axios.get(`${BASE_URL}/Images/Count`, {
            params: filterNull({ ...getAuthParams(), ...options }), timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'list-products': async (page, perPage) => {
        log('info', 'list-products', { page, perPage });
        const res = await axios.get(`${BASE_URL}/ProductIds`, {
            params: filterNull({ ...getAuthParams(), page: page ? parseInt(page, 10) : undefined, productIdsPerPage: perPage ? parseInt(perPage, 10) : undefined }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'delete': async (ticket, customerId) => {
        validateId(ticket, 'imageTicket');
        log('info', 'delete', { ticket });
        const res = await axios.delete(`${BASE_URL}/Image/${ticket}`, {
            data: filterNull({ ...getAuthParams(), customerImageId: customerId }),
            timeout: REQUEST_TIMEOUT
        });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'reject': async (ticket, comment, options = {}) => {
        validateId(ticket, 'imageTicket');
        log('info', 'reject', { ticket });
        const res = await axios.put(`${BASE_URL}/Image/Reject/${ticket}`, filterNull({
            ...getAuthParams(),
            comment,
            ...options
        }), { timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-contact': async () => {
        log('info', 'get-contact');
        const res = await axios.get(`${BASE_URL}/Contact`, { params: getAuthParams(), timeout: REQUEST_TIMEOUT });
        checkApiError(res.data);
        console.log(JSON.stringify(res.data, null, 2));
    },
    'get-invoices': async (options = {}) => {
        log('info', 'get-invoices', options);
        if (options.page) options.page = parseInt(options.page, 10);
        const res = await axios.get(`${BASE_URL}/Invoices`, {
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
        const res = await axios.post(`${BASE_URL}/AddColorLibrary`, payload, { timeout: REQUEST_TIMEOUT });
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
            if (cmd === 'upload') {
                if (options.colorwayIds) options.colorwayIds = JSON.parse(options.colorwayIds);
                await commands.upload(filteredArgs[0], filteredArgs[1], options);
            } else if (cmd === 'add-color-library') {
                await commands['add-color-library'](...filteredArgs);
            } else if (cmd === 'white-glove') {
                await commands['white-glove'](filteredArgs[0], options);
            } else if (cmd === 'stack') {
                await commands.stack(filteredArgs[0], filteredArgs[1], options);
            } else if (cmd === 'list-images' || cmd === 'count-images' || cmd === 'get-invoices') {
                await commands[cmd](options);
            } else if (cmd === 'reject') {
                await commands.reject(filteredArgs[0], filteredArgs[1], options);
            } else {
                await commands[cmd](...filteredArgs);
            }
        } catch (err) {
            console.error(redactSecrets(`[API_ERROR] ${err.message}`));
            if (err.response) console.error(redactSecrets(JSON.stringify(err.response.data, null, 2)));
            process.exit(1);
        }
    })();
} else {
    console.log(`Pixelz Platform CLI

Usage: node cli.js <command> [args] [--options]

Commands:
  list-templates                          List retouching specification templates
  get-template <id>                       Get template details by ID
  upload <path|url> <templateId> [opts]   Submit image for retouching
  white-glove <path|url> [opts]           Submit image for white-glove review
  stack <path|url> <templateId> [opts]    Submit image as part of a stack
  status <ticket> [customerId]            Get image processing status
  list-images [--status X] [--fromDate]   List images (status: 10/new, 60/in production, 70/production finished, 80/delivered)
  count-images [--status X] [--fromDate]  Count images (accepts same status names or codes)
  list-products [page] [perPage]          List product IDs with stats
  delete <ticket> [customerId]            Cancel image processing
  reject <ticket> <comment> [opts]        Request correction for delivered image
  get-contact                             Get account profile and balance
  get-invoices [--fromDate] [--toDate]    Get billing statements
  add-color-library <path|url>...         Register color swatches, get colorwayIds

Upload also accepts --colorwayIds='[123,456]' for color matching with registered swatches.

Options use --key=value or --key value syntax.`);
}
