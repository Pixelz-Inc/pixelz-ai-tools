---
name: platform-get-template-detail
description: Retrieve the full technical configuration of a specific Pixelz template. Use this to explain to users what background, margins, and file formats are being applied to their images.
---

# Get Template Detail (Pixelz Platform)

This skill provides the technical "blueprint" of a template, detailing exactly how images will be processed by Pixelz editors.

## Command
```bash
node cli-tools/platform/node/cli.js get-template <TEMPLATE_ID>
```

## Detailed Parameters
- `TEMPLATE_ID`: (Required) The unique integer identifying the specification. Found via the "List Templates" skill.

## Preferred Output
Summarize the JSON response into these bullet points:
- **Output Format**: (e.g., JPEG, PNG, TIFF)
- **Background**: (e.g., White, Transparent, Original)
- **Margins**: (e.g., 5% Top, 10% Bottom)
- **Alignment**: (e.g., Centered, Top-aligned)
- **Price**: Per image cost for this specification.

## Workflow guidance
- Use this to verify if a template meets a user's specific requirements (e.g., "Does this template produce transparent backgrounds?").
---
