const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function whiteGloveService() {
    const imageUrl = process.argv[2];
    const comment = process.argv[3] || "";

    if (!imageUrl) {
        console.log('Usage: node white-glove-service.js <imageUrl> [comment]');
        process.exit(1);
    }

    const auth = getAuthParams();
    try {
        const response = await axios.post(`${BASE_URL}/WhiteGloveService`, {
            ...auth,
            imageURL: imageUrl,
            comment: comment
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

whiteGloveService();
