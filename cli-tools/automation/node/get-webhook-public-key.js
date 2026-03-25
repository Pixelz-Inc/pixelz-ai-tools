const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

async function getWebhookPublicKey() {
    const token = await getAccessToken();
    try {
        const response = await axios.get(`${BASE_URL}/webhook/public-keys`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

getWebhookPublicKey();
