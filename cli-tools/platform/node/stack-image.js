const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function stackImage() {
    const imageUrl = process.argv[2];
    const templateId = process.argv[3];

    if (!imageUrl || !templateId) {
        console.log('Usage: node stack-image.js <imageUrl> <templateId>');
        process.exit(1);
    }

    const auth = getAuthParams();
    try {
        const response = await axios.post(`${BASE_URL}/StackImage`, {
            ...auth,
            imageURL: imageUrl,
            templateId: templateId
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

stackImage();
