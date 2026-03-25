---
name: platform-stack-image
description: Submit individual parts of a combined product stack on the Pixelz Platform.
---

# Stack Image (Pixelz Platform)

A stack combines multiple individual photos of the same product (e.g., different angles, separate garment pieces, or a multi-pack) into a single unified retouched result. Each part is submitted separately with the same `productId` to link them.

## Command
```bash
node cli-tools/platform/node/cli.js stack "<PATH_OR_URL>" [--template <ID>] [--customerImageId <ID>] [--productId <ID>] [--imageDeadlineDateTimeUTC <DATETIME>] [--imageCallbackURL <URL>]
```

## Detailed Parameters
- `PATH_OR_URL`: (Required) Local path or public URL for this part of the stack.
- `--template`: (Optional) Template ID specifying how the stack should be processed.
- `--productId`: (Required in practice) A shared ID linking all parts of the same stack. All submissions in the same stack must use the same `productId`.
- `--customerImageId`: (Optional) Your internal reference for this individual part.
- `--imageDeadlineDateTimeUTC`: (Optional) Deadline in `yyyy-MM-dd HH:mm:ss` format. Must be at least 24 hours in the future.
- `--imageCallbackURL`: (Optional) Webhook URL to notify when the stack is complete.

## Constraints
- All parts of the stack **must be submitted within 5 minutes** of each other. Submit them sequentially in rapid succession.
- Use the same `productId` for every part of the stack.

## Workflow Guidance
1. Confirm the total number of parts and their file paths before starting.
2. Submit all parts back-to-back using the same `productId`.
3. Use `platform-get-image-status` with any of the returned tickets to track overall stack progress.

## Success Criteria
- Confirm each part was submitted and record its `ImageTicket` GUID.
- Warn the user if submissions are taking too long (approaching the 5-minute window).
---
