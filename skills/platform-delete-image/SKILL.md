---
name: platform-delete-image
description: Cancel an image processing request and delete the ticket. Only possible before the image enters production.
---

# Delete Image (Pixelz Platform)

## Command
```bash
node cli-tools/platform/node/cli.js delete <IMAGE_TICKET>
```

## Workflow guidance
1. Confirm the ticket ID with the user.
2. If successful, confirm the deletion.
3. If it fails with "Image in production," explain that the work has already started and cannot be cancelled.
---
