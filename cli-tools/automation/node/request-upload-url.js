const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

async function requestUploadUrl() {
    const fileName = process.argv[2];

    if (!fileName) {
        console.log('Usage: node request-upload-url.js <fileName>');
        process.exit(1);
    }

    const token = await getAccessToken();
    try {
        const response = await axios.post(`${BASE_URL}/files/request-upload-url`, {
            fileName: fileName
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

requestUploadUrl();
