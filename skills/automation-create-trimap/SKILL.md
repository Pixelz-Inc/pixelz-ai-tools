---
name: automation-create-trimap
description: Generate an AI trimap for complex edge detection (hair, fur, transparent materials). Essential for high-end matting.
---

# Create Trimap (Pixelz Automation)

A trimap is a three-zone guidance image that classifies every pixel as definite foreground (white), definite background (black), or uncertain boundary (grey). Providing a trimap to the background removal or mask tools dramatically improves accuracy around complex edges like hair, fur, or translucent fabric.

## Command
```bash
node cli-tools/automation/node/cli.js create-trimap "<PATH_OR_URL>" [--callback <URL>]
```

## Input requirement
If the user has not provided a full file path or URL, ask for it before proceeding. Do not search the filesystem.

## Detailed Parameters
- `PATH_OR_URL`: (Required) Full path to a local image file or a direct public URL.
- `--callback`: (Optional) Webhook URL to receive the result automatically when processing is complete.

## Why to use this
- When the subject has fine hair, fur, or transparent/translucent edges that standard background removal struggles with.
- As a preparatory step before `create-mask` or `remove-bg` to improve edge quality on difficult images.

## Result
The command runs asynchronously by default. The response contains a `job_id`. After submitting:
1. Tell the user: *"Trimap generation is processing. Your job ID is `<job_id>`. Let me know when you want me to check the result."*
2. Remember the `job_id` for when the user asks for an update.
3. When the user asks to check, use the **Get Job Status** skill with that `job_id`.
4. When status is `FINISHED`, the response contains:
   - `result_image_url`: The trimap PNG — pass this as `--trimap <URL>` to `remove-bg` or `create-mask` for better edge quality.
   - `result_trimap_vector_url`: JSON vector format of the trimap (may be null).

## Synchronous mode (advanced users only)
Add `--sync` to the command to get the result immediately. Only do this if the user explicitly asks — it may time out on large images.
---
