const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

async function createMask() {
    const imageUrl = process.argv[2];
    const featherWidth = process.argv[3] ? parseFloat(process.argv[3]) : null;
    const trimapUrl = process.argv[4] || null;

    if (!imageUrl) {
        console.log('Usage: node create-mask.js <imageUrl> [featherWidth] [trimapUrl]');
        process.exit(1);
    }

    const token = await getAccessToken();
    try {
        const payload = { image_url: imageUrl };
        if (featherWidth !== null) payload.feather_width = featherWidth;
        if (trimapUrl) payload.trimap_url = trimapUrl;

        const response = await axios.post(`${BASE_URL}/images/create-mask`, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

createMask();
