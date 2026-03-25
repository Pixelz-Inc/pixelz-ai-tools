const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function getTemplateDetail() {
    const templateId = process.argv[2];
    if (!templateId) {
        console.log('Usage: node get-template-detail.js <templateId>');
        process.exit(1);
    }

    const auth = getAuthParams();
    try {
        const response = await axios.get(`${BASE_URL}/Template/${templateId}`, { params: auth });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

getTemplateDetail();
