const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });

const AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token';
const BASE_URL = 'https://automation-api.pixelz.com/v1';

async function getAccessToken() {
    const clientId = process.env.PIXELZ_AUTOMATION_CLIENT_ID;
    const clientSecret = process.env.PIXELZ_AUTOMATION_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error("Error: Missing PIXELZ_AUTOMATION_CLIENT_ID or PIXELZ_AUTOMATION_CLIENT_SECRET in .env");
        process.exit(1);
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        const response = await axios.post(AUTH_URL, params);
        return response.data.access_token;
    } catch (error) {
        console.error("Authentication failed:", error.message);
        process.exit(1);
    }
}

module.exports = { BASE_URL, getAccessToken };
