const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function countImages() {
    const imageStatus = process.argv[2] || "";
    const fromDate = process.argv[3] || "";
    const toDate = process.argv[4] || "";

    const auth = getAuthParams();
    const params = { ...auth };
    if (imageStatus) params.imageStatus = imageStatus;
    if (fromDate) params.fromDate = fromDate;
    if (toDate) params.toDate = toDate;

    try {
        const response = await axios.get(`${BASE_URL}/Images/Count`, { params });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

countImages();
