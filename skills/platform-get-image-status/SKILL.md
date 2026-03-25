---
name: platform-get-image-status
description: Monitor the real-time processing status of an image on the Pixelz platform. Use this to find the final download link once retouching is complete.
---

# Get Image Status (Pixelz Platform)

This skill tracks a retouching request through the production pipeline to completion.

## Command
```bash
node cli-tools/platform/node/cli.js status <IMAGE_TICKET> [--customer-id <CID>]
```

## Detailed Parameters
- `IMAGE_TICKET`: (Required) The unique GUID returned during upload.
- `--customer-id`: (Optional) If you used a custom tracking ID during upload, you can use it here by setting `IMAGE_TICKET` to "nonticket".

## Status Code Reference
Pixelz uses these IDs to represent progress:
- **10 (New)**: Received, waiting for an editor.
- **60 (In Production)**: A retouching expert is currently working on the image.
- **70 (Production Finished)**: Manual work done, undergoing quality control.
- **80 (Delivered)**: **SUCCESS.** Final image is ready.

## Success Criteria
- If status is **80**, extract the `FinalImagesURL` and present it as a clear download link.
- If status is **< 80**, give the user a human-friendly update (e.g., "Retouching is in progress").

## Troubleshooting
- If the tool returns a 404, double-check the `IMAGE_TICKET` GUID.
---
