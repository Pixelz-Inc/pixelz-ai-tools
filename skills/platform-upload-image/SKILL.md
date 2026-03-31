---
name: platform-upload-image
description: Submit an image for professional manual retouching on the Pixelz Platform. Supports both local file paths and public URLs.
---

# Upload Image (Pixelz Platform)

This skill initiates the manual retouching process. Pixelz editors will receive the image and apply the specified template settings.

## Command
```bash
node cli-tools/platform/node/cli.js upload "<PATH_OR_URL>" --template <ID> [--imageURL2 <URL>] [--imageURL3 <URL>] [--imageURL4 <URL>] [--imageURL5 <URL>] [--colorReferenceFileURL <URL>] [--imageCallbackURL <URL>] [--customerImageId <ID>] [--productId <ID>] [--customerFolder <NAME>] [--imageDeadlineDateTimeUTC <DATETIME>] [--comment <TEXT>] [--markupImageUrl <URL>] [--swatchImageURL <URL>] [--swatchColorCode <HEX>] [--markerX <INT>] [--markerY <INT>] [--outputFileName <NAME>] [--customerImageColorID <ID>] [--colorwayIds '<JSON_ARRAY>']
```

## Detailed Parameters
- `PATH_OR_URL`: (Required) Local path or direct URL to the primary image.
- `--template`: (Required) Numeric specification ID. Use `platform-list-templates` to find the right one.
- `--imageURL2` to `--imageURL5`: (Optional) Additional reference images (e.g., alternate angles for combining into one result).
- `--colorReferenceFileURL`: (Optional) URL of a reference image for color matching.
- `--imageCallbackURL`: (Optional) Webhook URL for a completion notification.
- `--customerImageId`: (Optional) Your internal reference string for this image.
- `--productId`: (Optional) Groups images together for consistent quality across a product set.
- `--customerFolder`: (Optional) Organise the image into a named folder on the platform.
- `--imageDeadlineDateTimeUTC`: (Optional) Deadline in `yyyy-MM-dd HH:mm:ss` format. Must be at least 24 hours in the future.
- `--comment`: (Optional) Free-text instructions for the retouching expert.
- `--markupImageUrl`: (Optional) URL to an annotated image to guide editors.
- `--swatchColorCode`: (Optional) Hex code for specific color matching (e.g., `"#FF0000"`).
- `--colorwayIds`: (Optional) JSON array of color library IDs from `platform-add-color-library` (e.g., `"[123,456]"`). Used for color matching with registered swatches.

## Success Criteria
- Confirm the image was successfully submitted.
- Record and present the returned `ImageTicket` GUID — the user will need it to check status or request corrections.
- Suggest using `platform-get-image-status` with that ticket to track progress.

## Troubleshooting
- If `--template` is unknown, run `platform-list-templates` first.
- If an `[AUTH_ERROR]` occurs, the user needs to set `PIXELZ_PLATFORM_API_KEY` and `PIXELZ_PLATFORM_EMAIL` in their `.env` file.
- If a `[PRESIGN_UNAVAILABLE]` error occurs, the account is not enabled for direct file uploads. Ask the user to provide a publicly accessible image URL (e.g. from S3, Google Cloud Storage, or any CDN) instead of a local file path. Do not retry with a local path.
---
