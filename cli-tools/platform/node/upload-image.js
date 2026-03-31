const axios = require('axios');
const { BASE_URL, getAuthParams } = require('./utils');

const args = process.argv.slice(2);
const imageUrl = args.find(arg => arg.startsWith('--url='))?.split('=')[1];
const templateId = args.find(arg => arg.startsWith('--template='))?.split('=')[1];
const colorwayIdsRaw = args.find(arg => arg.startsWith('--colorwayIds='))?.split('=')[1];

if (!imageUrl || !templateId) {
    console.log("Usage: node upload-image.js --url=<image_url> --template=<template_id> [--colorwayIds='[123,456]']");
    process.exit(1);
}

async function uploadImage() {
    try {
        const auth = getAuthParams();
        const payload = {
            ...auth,
            templateId: templateId,
            imageURL: imageUrl
        };
        if (colorwayIdsRaw) payload.colorwayIds = JSON.parse(colorwayIdsRaw);

        const response = await axios.post(`${BASE_URL}/Image`, payload);
        console.log(JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.error("Error uploading image:", error.message);
        if (error.response) console.error(error.response.data);
    }
}

uploadImage();
