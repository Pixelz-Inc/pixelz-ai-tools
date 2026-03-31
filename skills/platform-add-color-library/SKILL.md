---
name: platform-add-color-library
description: Register color reference images (swatches) and receive colorwayIds for use with upload_image color matching.
---

# Add Color Library (Pixelz Platform)

Register one or more color swatch images with the Pixelz color library. Returns an array of colorwayIds that can then be passed to `platform-upload-image` for color matching.

## Command
```bash
node cli-tools/platform/node/cli.js add-color-library "<PATH_OR_URL>" ["<PATH_OR_URL>" ...]
```

## Detailed Parameters
- `PATH_OR_URL`: (Required) One or more local file paths or public URLs of color swatch images. Provide multiple paths separated by spaces.

## Success Criteria
- Confirm the swatches were registered successfully.
- Record and present the returned `ColorwayIds` array — the user will need these IDs when uploading images with `platform-upload-image --colorwayIds`.
- Suggest using `platform-upload-image` with the `--colorwayIds` flag for color matching.

## Troubleshooting
- If an `[AUTH_ERROR]` occurs, the user needs to set `PIXELZ_PLATFORM_API_KEY` and `PIXELZ_PLATFORM_EMAIL` in their `.env` file.
- If a `[PRESIGN_UNAVAILABLE]` error occurs, the account is not enabled for direct file uploads. Ask the user to provide publicly accessible image URLs instead of local file paths.
---
