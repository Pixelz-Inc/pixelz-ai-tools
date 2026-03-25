const axios = require('axios');
const { BASE_URL, getAccessToken } = require('./utils');

const args = process.argv.slice(2);
const jobId = args.find(arg => arg.startsWith('--job='))?.split('=')[1];

if (!jobId) {
    console.log("Usage: node get-job-status.js --job=<job_id>");
    process.exit(1);
}

async function getStatus() {
    try {
        const token = await getAccessToken();
        const response = await axios.get(`${BASE_URL}/images/jobs/${jobId}/status`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        console.log(JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.error("Error:", error.message);
        if (error.response) console.error(error.response.data);
    }
}

getStatus();
