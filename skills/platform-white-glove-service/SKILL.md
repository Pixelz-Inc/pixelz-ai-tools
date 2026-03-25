---
name: platform-white-glove-service
description: Expert manual template selection for unknown product types on the Pixelz Platform. Pixelz retouching experts will manually review the image and select the best settings.
---

# White Glove Service (Pixelz Platform)

Use this when you don't know which template to apply. A Pixelz specialist will manually review the image and select the most appropriate processing settings before retouching begins. This is ideal for unusual product types or one-off requests.

## Command
```bash
node cli-tools/platform/node/cli.js white-glove "<PATH_OR_URL>" [--comment <TEXT>] [--markupImageUrl <URL>] [--customerImageId <ID>] [--productId <ID>] [--customerFolder <NAME>] [--imageCallbackURL <URL>] [--imageURL2 <URL>] [--imageURL3 <URL>] [--imageURL4 <URL>] [--imageURL5 <URL>]
```

## Detailed Parameters
- `PATH_OR_URL`: (Required) Local path or public URL of the primary image.
- `--comment`: (Optional) Instructions or context for the specialist (e.g., "Remove background, keep shadow"). The more detail, the better.
- `--markupImageUrl`: (Optional) URL to an annotated reference image to guide the retouching expert.
- `--customerImageId`: (Optional) Your internal tracking ID for this image.
- `--productId`: (Optional) Group images by product for consistent handling across a batch.
- `--customerFolder`: (Optional) Organise the image into a named folder on the Pixelz platform.
- `--imageCallbackURL`: (Optional) Webhook URL to receive a notification when retouching is complete.
- `--imageURL2` to `--imageURL5`: (Optional) Additional reference images (e.g., alternate angles of the same product).

## Why to use this
- When the product type is unusual and no existing template fits (e.g., a complex jewellery piece or a large furniture set).
- When a human expert opinion on the best processing approach is needed.

## Success Criteria
- Confirm the image was submitted and record the returned `ImageTicket` GUID.
- Use `platform-get-image-status` with that ticket to track progress.
- Note that White Glove jobs may take longer than standard template jobs due to the manual review step.
---
