---
name: automation-remove-background
description: High-speed, AI-powered background removal. Instantly remove backgrounds and make them transparent or a specific color. Supports local file paths and public URLs.
---

# Remove Background (Pixelz Automation)

This skill provides the fastest path to a clean product cutout using specialized AI models built for fashion e-commerce.

## Command
```bash
node cli-tools/automation/node/cli.js remove-bg "<PATH_OR_URL>" [--color <HEX>] [--transparent <true|false>] [--feather <FLOAT>] [--trimap <URL>] [--callback <URL>]
```

## Input requirement
If the user has not provided a full file path or URL, ask for it before proceeding. Do not search the filesystem for the file — the user must supply the exact path (e.g., `C:\Dev\pixelztest\test.jpeg`).

## Detailed Parameters
- `PATH_OR_URL`: (Required) Full path to a local image file or a direct public URL. The tool handles secure S3 upload automatically for local files.
- `--color`: (Optional) Hex color code for the replacement background (e.g., `"#FFFFFF"` for white). Mutually exclusive with `--transparent true`.
- `--transparent`: (Optional) Set to `true` to receive a PNG with an alpha transparency layer. This is the default if `--color` is not provided.
- `--feather`: (Optional) Soften the subject's edges. Values `0`–`1` produce sharp edges; higher values (e.g., `2.0`) create softer transitions. Useful for hair and fabric.
- `--trimap`: (Optional) URL to a custom trimap image for precise foreground/background separation on complex edges. Generate one first with `automation-create-trimap`.
- `--callback`: (Optional) Webhook URL to receive the result notification once processing is complete.

## Why to use this
- To instantly generate a transparent PNG of a product.
- To standardize background colors across a catalog without manual retouching.

## Result
The command runs asynchronously by default. The response contains a `job_id`. After submitting:
1. Tell the user: *"Background removal is processing. Your job ID is `<job_id>`. Let me know when you want me to check the result."*
2. Remember the `job_id` for when the user asks for an update.
3. When the user asks to check, use the **Get Job Status** skill with that `job_id`.
4. When status is `FINISHED`, present the `result_image_url` as a download link.

## Synchronous mode (advanced users only)
Add `--sync` to the command to get the result immediately without polling. Only do this if the user explicitly asks — it may time out on large images.
---
