const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

async function createTrimap() {
    const imageUrl = process.argv[2];

    if (!imageUrl) {
        console.log('Usage: node create-trimap.js <imageUrl>');
        process.exit(1);
    }

    const token = await getAccessToken();
    try {
        const response = await axios.post(`${BASE_URL}/images/create-trimap`, {
            image_url: imageUrl
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

createTrimap();
