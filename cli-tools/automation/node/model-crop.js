const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

async function modelCrop() {
    const imageUrl = process.argv[2];
    const topCrop = process.argv[3] || null;
    const bottomCrop = process.argv[4] || null;

    if (!imageUrl) {
        console.log('Usage: node model-crop.js <imageUrl> [topCrop] [bottomCrop]');
        process.exit(1);
    }

    const token = await getAccessToken();
    try {
        const payload = { image_url: imageUrl };
        if (topCrop) payload.top_crop_location = topCrop;
        if (bottomCrop) payload.bottom_crop_location = bottomCrop;

        const response = await axios.post(`${BASE_URL}/images/model-crop`, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

modelCrop();
