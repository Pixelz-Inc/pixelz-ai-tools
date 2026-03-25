const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function getImageStatus() {
    const imageTicket = process.argv[2];
    if (!imageTicket) {
        console.log('Usage: node get-image-status.js <imageTicket>');
        process.exit(1);
    }

    const auth = getAuthParams();
    try {
        const response = await axios.get(`${BASE_URL}/Image/${imageTicket}`, { params: auth });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

getImageStatus();
