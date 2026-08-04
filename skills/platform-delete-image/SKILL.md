---
name: platform-delete-image
description: Cancel an image processing request and delete the ticket. Only possible before the image enters production.
---

# Delete Image (Pixelz Platform)

## Command
```bash
node cli-tools/platform/node/cli.js delete <IMAGE_TICKET> [--customer-id <ID>]
```

## Detailed Parameters
- `IMAGE_TICKET`: (Required) The GUID returned at upload. If you are identifying the image
  by your own reference instead, pass the literal string `nonticket` here and supply
  `--customer-id`.
- `--customer-id`: (Optional) Your internal reference ID for the image, if you set one at
  upload time.

## Workflow guidance
1. **Confirm the ticket ID with the user before calling — this is destructive and cannot be undone.**
2. Deletion is only possible before the image enters production (status < 60). Check with
   `platform-get-image-status` first if you are unsure.
3. If successful, confirm the deletion.
4. If it fails with "Image in production," explain that the work has already started and cannot be cancelled.

## Troubleshooting
- A 404 usually means the ticket GUID is wrong — re-check it with `platform-list-images`.
- If an `[AUTH_ERROR]` occurs, the user needs `PIXELZ_PLATFORM_EMAIL` and
  `PIXELZ_PLATFORM_API_KEY` set in their `.env` file.
---
