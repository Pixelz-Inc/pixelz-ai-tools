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
This is the canonical status table. Other Platform skills refer here rather than repeating it.

| Code | Meaning | What to tell the user / do |
|---|---|---|
| 0 | Deleted by user | The image was deleted; nothing further will happen. |
| 10 | New | Received, waiting to enter production. |
| 12 | New – download failed | Pixelz could not download the source image. Check that the image URL is publicly reachable, then resubmit. |
| 20 | (Deprecated) waiting for payment | Treat as not yet in production; point the user to their account. |
| 30 | Ready for production | Queued for an editor. |
| 40 | Returned for production (by you) | A correction was requested (reject); it is back in the queue. |
| 60 | In production | Being retouched. |
| 62 | Assigned to editor | Being retouched. |
| 64 | Downloaded by editor | Being retouched. |
| 66 | Quality assurance | Retouching done, in QA. |
| 70 | Production finished – ready for download | Result is ready. |
| 72 / 74 / 76 | Production finished – 1st / 2nd / 3rd delivery attempt failed | Result is ready, but the webhook to `imageCallbackURL` failed; Pixelz retries. |
| 78 | Production finished – delivery failed | Result is ready, but all webhook deliveries failed; check the callback URL. |
| 80 | Delivered | Success — final image delivered. |
| 90 | Rejected by Pixelz | Pixelz could not process the image; tell the user and suggest contacting Pixelz support or resubmitting. |
| 95 | Awaiting your reply | Pixelz has a question about this image; the user must respond in their Pixelz account before work continues. |
| 100 | Closed | Finished and closed. |
| 999 | Deleted by cleanup service | The image was removed after retention expired. |

## Success Criteria
- Whenever the response contains a non-empty `FinalImagesURL` (normally from status 70 upward), present it as a clear download link.
- For 10, 30, 40 and 60–66, give a human-friendly in-progress update (e.g., "Retouching is in progress").
- For 12, 90 and 95, tell the user action is needed and what to do, as given in the table.
- For 0, 100 and 999, say so plainly.
- Never describe an unknown code as "in progress". Report the number instead.

## Troubleshooting
- If the tool returns a 404, double-check the `IMAGE_TICKET` GUID.
---
