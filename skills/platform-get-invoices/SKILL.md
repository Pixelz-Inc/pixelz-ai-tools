---
name: platform-get-invoices
description: Retrieve a list of billing statements and payment links from the Pixelz platform.
---

# Get Invoices (Pixelz Platform)

Fetches the account's billing history, including invoice amounts and direct payment URLs.

## Command
```bash
node cli-tools/platform/node/cli.js get-invoices [--fromDate <YYYY-MM-DD>] [--toDate <YYYY-MM-DD>] [--page <N>] [--returnUrl <URL>]
```

## Detailed Parameters
- `--fromDate`: (Optional) Only return invoices issued on or after this date (`YYYY-MM-DD`).
- `--toDate`: (Optional) Only return invoices issued on or before this date (`YYYY-MM-DD`).
- `--page`: (Optional) Page number for paginated results (Default: 1).
- `--returnUrl`: (Optional) A URL in your application to redirect the user back to after payment is completed.

## Success Criteria
- Display results as a Markdown table with columns: Invoice ID, Date, Amount, Currency, Status.
- If a payment URL is present on any invoice, present it as a clickable link.
- If no invoices are returned, confirm the account has no invoices in the specified date range.
---
