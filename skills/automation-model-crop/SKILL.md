---
name: automation-model-crop
description: AI-powered model image cropping. Automatically align and crop photography based on specific model features like eyes, chin, or knees.
---

# Model Crop (Pixelz Automation)

This skill uses advanced computer vision to detect model anatomy and apply standardized cropping for consistent framing across photography sets.

## Tool/Integration
- **CLI Command**: `node cli-tools/automation/node/cli.js model-crop "<PATH_OR_URL>" [--top <LOCATION>] [--bottom <LOCATION>] [--callback <URL>]`

## Input requirement
If the user has not provided a full file path or URL, ask for it before proceeding. Do not search the filesystem.

## Detailed Parameters
- `PATH_OR_URL`: (Required) Full path to a local image file or a direct public URL.
- `--top`: (Optional) The anatomical feature to align the top of the crop to.
- `--bottom`: (Optional) The anatomical feature to align the bottom of the crop to.
- `--callback`: (Optional) Webhook URL for asynchronous result delivery.

### Supported Feature Locations (Enums)
Use these exact strings for `--top` and `--bottom`:
- `eye_higher`: Highest point of the eyes.
- `below_eye`: Just below the eyes.
- `btw_eye_and_nose`: Between eyes and nose.
- `below_nose`: Just below the nose.
- `between_nose_and_mouth`: Between nose and mouth.
- `below_mouth`: Just below the mouth.
- `below_chin`: Bottom of the chin.
- `chest`: Center of the chest.
- `at_elbow_higher`: Top of the elbows.
- `at_elbow_lower`: Bottom of the elbows.
- `waist`: Natural waistline.
- `below_buttock`: Just below the buttocks.
- `main_body_axis`: Center body alignment.
- `mid_thigh`: Middle of the thigh.
- `above_knee`: Just above the knees.
- `at_knee`: Center of the knee caps.
- `below_knee`: Just below the knees.

## Why to use this
- To automate high-volume model photography cropping.
- To ensure perfect alignment across a product category (e.g., all shirts cropped at the waist).

## Result
The command runs asynchronously by default. The response contains a `job_id`. After submitting:
1. Tell the user: *"Model crop is processing. Your job ID is `<job_id>`. Let me know when you want me to check the result."*
2. Remember the `job_id` for when the user asks for an update.
3. When the user asks to check, use the **Get Job Status** skill with that `job_id`.
4. When status is `FINISHED`, present the `result_image_url` as a download link.

## Synchronous mode (advanced users only)
Add `--sync` to the command to get the result immediately. Only do this if the user explicitly asks — it may time out on large images.
---
