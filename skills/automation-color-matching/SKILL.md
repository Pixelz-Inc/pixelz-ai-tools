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
  - `swatch_color_code`: Target hex color to match at this point (e.g., `"#FF5733"`). Use this OR `swatch_image`.
  - `swatch_image`: Object for matching against a reference image instead of a hex value. Use this OR `swatch_color_code`. Requires:
    - `swatch_image_url`: URL of the reference swatch image.
    - `x_coordinate`: X position within the swatch image to sample.
    - `y_coordinate`: Y position within the swatch image to sample.
- `--callback`: (Optional) Webhook URL for result delivery when processing is complete.

**Marker rules:**
- Each marker needs EXACTLY ONE of `swatch_color_code` or `swatch_image`: not both, not neither.
- Coordinates are integers.
- Place the sample point at the centre of a 30×30 px block that avoids shadows and highlights, so the sampled colour is representative.

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
4. When `status.status_name` is `Completed` or `Delivered`, present `result.result_image_url` as a download link.

## Synchronous mode (advanced users only)
Add `--sync` to the command to get the result immediately. Only do this if the user explicitly asks — it may time out on large images.

## Troubleshooting
- Local files must be JPG, JPEG, PNG or WEBP. Any other extension returns `[VALIDATION_ERROR]`. A public URL is not checked locally.
- If `[UPLOAD_UNAVAILABLE]` occurs, the account is not enabled for direct file uploads (it is off by default on the Automation API). Ask the user for a publicly accessible image URL instead. Do not retry with a local path.
- If `[VALIDATION_ERROR]` mentions the markers, check that each one has exactly one of `swatch_color_code` or `swatch_image`, and that all coordinates are integers.
---
