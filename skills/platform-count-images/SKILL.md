---
name: platform-count-images
description: Return only a total number of images matching a filter — no per-image detail. Use for "how many…" questions; to see the images themselves, use platform-list-images instead.
---

# Count Images (Pixelz Platform)

Returns the total number of images in the account that match the given filters. Useful for getting a quick summary before deciding to run a full list.

## Command
```bash
node cli-tools/platform/node/cli.js count-images [--status <CODE|NAME>] [--fromDate <YYYY-MM-DD>] [--toDate <YYYY-MM-DD>]
```

## Detailed Parameters
- `--status`: (Optional) Filter by status. Accepts either a numeric code or a name:
  `10`/`new`, `60`/`in production`, `70`/`production finished`, `80`/`delivered`.
  Names are case-insensitive. `--imageStatus` works as an alias. Omit to count all images.
- `--fromDate`: (Optional) Only count images created on or after this date (`YYYY-MM-DD`).
- `--toDate`: (Optional) Only count images created on or before this date (`YYYY-MM-DD`).

## Status Code Reference
- **10** — New (waiting for an editor)
- **60** — In Production
- **70** — Production Finished (in QC)
- **80** — Delivered

## Success Criteria
- Report the count as a clear number, e.g. "There are 142 delivered images in the account."
- If filters were applied, confirm which filters were used in the response.
---
