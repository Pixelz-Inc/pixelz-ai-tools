---
name: automation-color-matching
description: AI-powered color correction. Precisely match product colors to a reference set of markers or swatch images.
---

# Color Matching (Pixelz Automation)

Adjust product colors using AI to match physical samples or reference targets. You provide coordinate markers on the image and target color values; the AI corrects the image to match.

## Command
```bash
node cli-tools/automation/node/cli.js color-match "<PATH_OR_URL>" '<MARKERS_JSON>' [--callback <URL>]
```

## Input requirement
If the user has not provided a full file path or URL, ask for it before proceeding. Do not search the filesystem.

## Detailed Parameters
- `PATH_OR_URL`: (Required) Full path to a local image file or a direct public URL.
- `MARKERS_JSON`: (Required) A JSON string array of marker objects. Each object requires:
  - `x_coordinate`: Horizontal pixel position of the color sample point (integer).
  - `y_coordinate`: Vertical pixel position of the color sample point (integer).
  - `swatch_color_code`: (Optional) Target hex color to match at this point (e.g., `"#FF5733"`).
  - `swatch_image`: (Optional) Object for matching against a reference image instead of a hex value. Requires:
    - `swatch_image_url`: URL of the reference swatch image.
    - `x_coordinate`: X position within the swatch image to sample.
    - `y_coordinate`: Y position within the swatch image to sample.
- `--callback`: (Optional) Webhook URL for result delivery when processing is complete.

**Example `MARKERS_JSON`:**
```json
[{"x_coordinate": 120, "y_coordinate": 340, "swatch_color_code": "#FFFFFF"}]
```

## Why to use this
- To standardize colors across a product catalog (e.g., all "cream" products should match the same white tone).
- To correct color casts introduced by varying lighting conditions during photography.

## Result
The command runs asynchronously by default. The response contains a `job_id`. After submitting:
1. Tell the user: *"Color matching is processing. Your job ID is `<job_id>`. Let me know when you want me to check the result."*
2. Remember the `job_id` for when the user asks for an update.
3. When the user asks to check, use the **Get Job Status** skill with that `job_id`.
4. When status is `FINISHED`, present the `result_image_url` as a download link.

## Synchronous mode (advanced users only)
Add `--sync` to the command to get the result immediately. Only do this if the user explicitly asks — it may time out on large images.
---
