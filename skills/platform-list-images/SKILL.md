---
name: platform-list-images
description: Search and list images processed on the Pixelz platform. Filter by status, date, product ID, and pagination.
---

# List Images (Pixelz Platform)

This skill allows you to retrieve history and progress for multiple images in the account.

## Tool/Integration
- **CLI Command**: `node cli-tools/platform/node/cli.js list-images [--status <ID>] [--excludeImageStatus <ID>] [--productId <ID>] [--fromDate <YYYY-MM-DD>] [--toDate <YYYY-MM-DD>] [--page <N>] [--imagesPerPage <N>] [--sortBy <id|date|status>] [--isDescending <true|false>]`

## Detailed Parameters
- `--status`: (Optional) Filter by numeric status (e.g. 80 for Delivered).
- `--excludeImageStatus`: (Optional) Do not show images with this status.
- `--productId`: (Optional) Show only images belonging to this product batch.
- `--fromDate` / `--toDate`: (Optional) ISO date range for created date.
- `--page`: (Optional) Result page number (Default: 1).
- `--imagesPerPage`: (Optional) Records per page (Max: 100).
- `--sortBy`: (Optional) Field to sort by: `id`, `date`, or `status`.
- `--isDescending`: (Optional) Set to `true` for reverse order.

## Success Criteria
- Display results in a Markdown table with Ticket ID, Status, and Date.
---
