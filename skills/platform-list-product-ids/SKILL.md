---
name: platform-list-product-ids
description: View production statistics grouped by Product ID. Useful for tracking completion of entire product batches.
---

# List Product IDs (Pixelz Platform)

Track progress for batches of images belonging to the same product.

## Command
```bash
node cli-tools/platform/node/cli.js list-products [--page <N>] [--per-page <N>]
```

## Detailed Parameters
- `--page`: (Optional) Page number for results.
- `--per-page`: (Optional) Records per page (Default: 10).

## Data Interpretation
- `TodoCount`: Images still in production.
- `DoneCount`: Images finished and delivered.

## Success Criteria
- Present as a Markdown table.
- Highlight products that are 100% complete.
---
