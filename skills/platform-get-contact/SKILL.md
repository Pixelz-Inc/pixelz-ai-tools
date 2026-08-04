---
name: platform-get-contact
description: Retrieve account profile, company details, and current credit balance from the Pixelz platform.
---

# Get Contact Info (Pixelz Platform)

## Command
```bash
node cli-tools/platform/node/cli.js get-contact
```

Takes no parameters — it always returns the account tied to the configured credentials.

## Why to use this
- To check the remaining credit balance before submitting a large batch of images.
- To confirm which Pixelz account the current credentials belong to.

## Success Criteria
- Report the `ContactAccountBalance` together with its `Currency` — the number is
  meaningless without it.
- Mention the account/company name so the user can confirm they are on the intended account.

## Troubleshooting
- If an `[AUTH_ERROR]` occurs, the user needs `PIXELZ_PLATFORM_EMAIL` and
  `PIXELZ_PLATFORM_API_KEY` set in their `.env` file.
- A `401`/`403` with credentials present usually means the API key has been rotated —
  ask the user to re-copy it from the Pixelz web portal.
---
