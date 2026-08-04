---
name: platform-list-images
description: List individual images with their ticket IDs, statuses and dates. Use when the user wants to see or act on specific images — for a total number only, use platform-count-images instead.
---

# List Images (Pixelz Platform)

This skill allows you to retrieve history and progress for multiple images in the account.

## Tool/Integration
- **CLI Command**: `node cli-tools/platform/node/cli.js list-images [--status <CODE|NAME>] [--excludeImageStatus <CODE|NAME>] [--productId <ID>] [--fromDate <YYYY-MM-DD>] [--toDate <YYYY-MM-DD>] [--page <N>] [--imagesPerPage <N>] [--sortBy <id|date|status>] [--isDescending <true|false>]`

## Detailed Parameters
- `--status`: (Optional) Filter by status. Accepts either a numeric code or a name:
  `10`/`new`, `60`/`in production`, `70`/`production finished`, `80`/`delivered`.
  Names are case-insensitive. `--imageStatus` works as an alias.
- `--excludeImageStatus`: (Optional) Do not show images with this status. Accepts the same
  codes and names.
- `--productId`: (Optional) Show only images belonging to this product batch.
- `--fromDate` / `--toDate`: (Optional) ISO date range for created date.
- `--page`: (Optional) Result page number (Default: 1).
- `--imagesPerPage`: (Optional) Records per page (Max: 100).
- `--sortBy`: (Optional) Field to sort by: `id`, `date`, or `status`.
- `--isDescending`: (Optional) Set to `true` for reverse order.

## Success Criteria
- Display results in a Markdown table with Ticket ID, Status, and Date.
---
