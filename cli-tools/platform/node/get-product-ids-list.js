const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function getProductIdsList() {
    const page = process.argv[2] || 1;
    const perPage = process.argv[3] || 10;

    const auth = getAuthParams();
    const params = { ...auth, page, productIdsPerPage: perPage };

    try {
        const response = await axios.get(`${BASE_URL}/ProductIds`, { params });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

getProductIdsList();
