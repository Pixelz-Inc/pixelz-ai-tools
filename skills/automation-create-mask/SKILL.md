---
name: automation-create-mask
description: AI tool to generate a grayscale silhouette mask of the product. Useful for advanced compositing and masking workflows.
---

# Create Mask (Pixelz Automation)

Generates a pixel-perfect greyscale mask of the main subject. The result is a black-and-white PNG where **white = subject** and **black = background**. Use it in compositing tools to isolate and reuse the subject independently.

## Command
```bash
node cli-tools/automation/node/cli.js create-mask "<PATH_OR_URL>" [--feather <FLOAT>] [--trimap <URL>] [--callback <URL>]
```

## Input requirement
If the user has not provided a full file path or URL, ask for it before proceeding. Do not search the filesystem.

## Detailed Parameters
- `PATH_OR_URL`: (Required) Full path to a local image file or a direct public URL.
- `--feather`: (Optional) Float value to soften mask edges. Values near `0` produce sharp edges; higher values (e.g., `1.5` or `2.0`) produce soft, blended edges. Use for images where a hard cutout would look unnatural.
- `--trimap`: (Optional) URL of a trimap image to guide the AI on complex boundary regions (hair, fur, transparent fabric). Generate one first with the `automation-create-trimap` skill.
- `--callback`: (Optional) Webhook URL to receive the result automatically when processing finishes.

## Why to use this
- When you need the subject as a reusable layer for compositing into different backgrounds.
- When `remove-bg` produces the right shape but you need the mask separately for further editing.

## Result
The command runs asynchronously by default. The response contains a `job_id`. After submitting:
1. Tell the user: *"Mask creation is processing. Your job ID is `<job_id>`. Let me know when you want me to check the result."*
2. Remember the `job_id` for when the user asks for an update.
3. When the user asks to check, use the **Get Job Status** skill with that `job_id`.
4. When status is `FINISHED`, present the `result_image_url` and explain: white = subject, black = background.

## Synchronous mode (advanced users only)
Add `--sync` to the command to get the result immediately. Only do this if the user explicitly asks — it may time out on large images.
---
