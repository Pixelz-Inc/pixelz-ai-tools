const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

async function listTemplates() {
    try {
        const params = getAuthParams();
        const response = await axios.get(`${BASE_URL}/Templates`, { params });
        
        if (response.data && response.data.Templates) {
            console.log(JSON.stringify(response.data.Templates, null, 2));
        } else {
            console.log("No templates found or error in response.");
            console.log(response.data);
        }
    } catch (error) {
        console.error("Error fetching templates:", error.message);
    }
}

listTemplates();
