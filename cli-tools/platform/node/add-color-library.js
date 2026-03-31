const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

const imageUrls = process.argv.slice(2);

if (imageUrls.length === 0) {
    console.log("Usage: node add-color-library.js <url> [url] ...");
    process.exit(1);
}

async function addColorLibrary() {
    try {
        const auth = getAuthParams();
        const payload = {
            ...auth,
            imagesUrl: imageUrls
        };

        const response = await axios.post(`${BASE_URL}/AddColorLibrary`, payload);
        console.log(JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.error("Error adding color library:", error.message);
        if (error.response) console.error(error.response.data);
    }
}

addColorLibrary();
