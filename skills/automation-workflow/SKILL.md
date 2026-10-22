---
name: automation-workflow
description: Master guide for the full asynchronous lifecycle of any Pixelz Automation job — submit, poll, and retrieve results.
---

# Automation Master Workflow

All Pixelz Automation operations (background removal, color matching, masking, trimap, model crop) follow the same three-step async pattern.

---

## Step 1 — Submit the Job

Run the appropriate command for the task. Each returns a `job_id` immediately. After submitting, tell the user their `job_id` and let them know they can ask you to check the status at any time.

```bash
# Background removal
node cli-tools/automation/node/cli.js remove-bg "<PATH_OR_URL>" [--transparent true] [--color <HEX>]

# Color matching
node cli-tools/automation/node/cli.js color-match "<PATH_OR_URL>" '<MARKERS_JSON>'

# Generate mask
node cli-tools/automation/node/cli.js create-mask "<PATH_OR_URL>" [--feather <FLOAT>]

# Generate trimap (use before mask/remove-bg for complex edges)
node cli-tools/automation/node/cli.js create-trimap "<PATH_OR_URL>"

# Model crop
node cli-tools/automation/node/cli.js model-crop "<PATH_OR_URL>" [--top <LOCATION>] [--bottom <LOCATION>]
```

Capture the `job_id` from the response.

---

## Step 2 — Poll for Status

```bash
node cli-tools/automation/node/cli.js status <JOB_ID>
```

Most jobs finish in **30–60 seconds**; large or complex images can take several minutes.

Run the status command **once per check — never in a loop**. You cannot wait out a
wall-clock interval mid-turn, and back-to-back calls only add API load without advancing
the job. If the job is still running, report the status and check again on a later turn or
when the user asks.

See `automation-get-job-status` for the full status table and result handling.

---

## Step 3 — Deliver the Result

When `status.status_name` is `Completed` or `Delivered`:
- Extract `result.result_image_url` from the response.
- Present it as a direct download link to the user.
- For mask results: explain the image is greyscale (white = subject, black = background).
- For trimap results: advise passing the URL as `--trimap` to `remove-bg` or `create-mask` for improved edge quality.

If `status.status_name` is `Failed`:
- Report the error message from the response to the user.
- Ask whether they want to resubmit with adjusted parameters.

---

## Synchronous mode (advanced users only)
Add `--sync` to any submit command to get the result immediately without polling. Only do this if the user explicitly requests it — sync mode can time out on large images.

## Using Webhooks (Optional)
Pass `--callback <URL>` to any submit command to receive an HTTP POST notification when the job finishes, instead of polling. Verify the webhook signature using `automation-get-webhook-public-key`.
---
