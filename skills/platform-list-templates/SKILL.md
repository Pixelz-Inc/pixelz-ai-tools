---
name: platform-list-templates
description: Retrieve a list of all processing templates available in the Pixelz Platform. Use this to identify the correct specification for background removal, alignment, and formatting before processing images.
---

# List Templates (Pixelz Platform)

This skill enables you to browse all retouching specifications (templates) currently configured in the Pixelz account. A template is a predefined set of instructions that Pixelz editors follow to ensure consistent quality and style.

## Command
```bash
node cli-tools/platform/node/cli.js list-templates
```

## Why to use this
- To discover the `templateId` required for image processing.
- To verify if a specific retouching style (e.g., "Invisible Man", "On-Model") is ready for use.

## Success Criteria
- **Output Formatting**: Display the results in a clean Markdown table with columns: `Template ID`, `Name`, and `Status`.
- If the list is empty, explain that templates must be created via the Pixelz web portal.

## Troubleshooting
- **Missing Credentials**: If an `[AUTH_ERROR]` occurs, inform the user they need to set `PIXELZ_PLATFORM_API_KEY` in their `.env` file.
---
