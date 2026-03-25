const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function getInvoices() {
    const fromDate = process.argv[2] || "";
    const toDate = process.argv[3] || "";
    const page = process.argv[4] || 1;

    const auth = getAuthParams();
    const params = { ...auth };
    if (fromDate) params.fromDate = fromDate;
    if (toDate) params.toDate = toDate;
    params.page = page;

    try {
        const response = await axios.get(`${BASE_URL}/Invoices`, { params });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

getInvoices();
