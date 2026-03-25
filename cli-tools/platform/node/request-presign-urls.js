const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function requestPresignUrls() {
    const imageNames = process.argv[2] ? JSON.parse(process.argv[2]) : [];

    if (imageNames.length === 0) {
        console.log('Usage: node request-presign-urls.js <imageNamesJSON>');
        console.log('Example: node request-presign-urls.js "[\\"img1.jpg\\",\\"img2.jpg\\"]"');
        process.exit(1);
    }

    const auth = getAuthParams();
    try {
        const response = await axios.post(`${BASE_URL}/RequestPresignUrls`, {
            ...auth,
            imageNames: imageNames
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

requestPresignUrls();
