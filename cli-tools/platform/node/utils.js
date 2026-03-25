const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const BASE_URL = 'https://api.pixelz.com/REST.svc/JSON';

const getAuthParams = () => {
    const email = process.env.PIXELZ_PLATFORM_EMAIL;
    const apiKey = process.env.PIXELZ_PLATFORM_API_KEY;
    
    if (!email || !apiKey) {
        console.error("Error: Missing PIXELZ_PLATFORM_EMAIL or PIXELZ_PLATFORM_API_KEY in .env");
        process.exit(1);
    }
    return { contactEmail: email, contactAPIkey: apiKey };
};

module.exports = { BASE_URL, getAuthParams };
