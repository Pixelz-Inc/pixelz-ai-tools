const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

async function colorMatching() {
    const imageUrl = process.argv[2];
    const colorMarkers = process.argv[3] ? JSON.parse(process.argv[3]) : [];

    if (!imageUrl || colorMarkers.length === 0) {
        console.log('Usage: node color-matching.js <imageUrl> <colorMarkersJSON>');
        console.log('Example: node color-matching.js "http://example.com/img.jpg" "[{\\"x_coordinate\\":100,\\"y_coordinate\\":100,\\"swatch_color_code\\":\\"#FF5733\\"}]"');
        process.exit(1);
    }

    const token = await getAccessToken();
    try {
        const response = await axios.post(`${BASE_URL}/images/color-matching`, {
            image_url: imageUrl,
            color_markers: colorMarkers
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

colorMatching();
