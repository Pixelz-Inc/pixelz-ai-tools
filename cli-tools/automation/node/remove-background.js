const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

const args = process.argv.slice(2);
const imageUrl = args.find(arg => arg.startsWith('--url='))?.split('=')[1];

if (!imageUrl) {
    console.log("Usage: node remove-background.js --url=<image_url>");
    process.exit(1);
}

async function removeBackground() {
    try {
        const token = await getAccessToken();
        const payload = {
            image_url: imageUrl,
            transparent_background: true
        };

        const response = await axios.post(`${BASE_URL}/images/remove-background`, payload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.error("Error:", error.message);
        if (error.response) console.error(error.response.data);
    }
}

removeBackground();
