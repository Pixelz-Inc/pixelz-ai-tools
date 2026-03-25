const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function getContactInfo() {
    const auth = getAuthParams();
    try {
        const response = await axios.get(`${BASE_URL}/Contact`, { params: auth });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

getContactInfo();
