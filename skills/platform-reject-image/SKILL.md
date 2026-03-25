---
name: platform-reject-image
description: Request a correction (redo) for a delivered image. Only valid for images with status 80 (Delivered).
---

# Reject Image (Pixelz Platform)

Sends a correction request back to Pixelz editors for a delivered image. The image re-enters the production queue and is re-processed at no extra charge.

## Command
```bash
node cli-tools/platform/node/cli.js reject <TICKET> "<COMMENT>" [--markupImageUrl <URL>] [--customerImageId <ID>]
```

## Detailed Parameters
- `TICKET`: (Required) The GUID of the delivered image to reject.
- `COMMENT`: (Required) A clear description of what needs to be corrected. Be as specific as possible — this goes directly to the retouching expert.
- `--markupImageUrl`: (Optional) URL to an annotated image showing exactly what needs fixing (e.g., areas marked in red).
- `--customerImageId`: (Optional) Your internal reference ID for the image.

## Workflow Guidance
1. Confirm the ticket GUID and correction description with the user before submitting.
2. Encourage the user to be specific in the comment (e.g., "Background colour should be pure white #FFFFFF, not off-white" rather than "fix the background").
3. After rejection, the image status resets from 80 to a processing state — use `platform-get-image-status` to track it back to delivery.

## Success Criteria
- Confirm the rejection was submitted successfully.
- Remind the user to check back using the same ticket GUID when the corrected image is ready.

## Troubleshooting
- If the command fails with a status error, confirm the image is at status **80 (Delivered)**. Rejection is not possible for images still in production.
---
