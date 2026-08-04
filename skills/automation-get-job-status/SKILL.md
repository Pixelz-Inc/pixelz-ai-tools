---
name: automation-get-job-status
description: Monitor the real-time progress of an asynchronous Pixelz Automation job.
---

# Get Job Status (Pixelz Automation)

## Command
```bash
node cli-tools/automation/node/cli.js status <JOB_ID>
```

## When to use this
All automation commands (`remove-bg`, `color-match`, etc.) run asynchronously by default and return a `job_id`. Use this skill when the user asks to check the status of a previously submitted job.

## Detailed Parameters
- `JOB_ID`: (Required) The `job_id` returned when the job was submitted.

## Response States

This is the canonical status table — other automation skills refer here rather than
repeating it.

| Status | Meaning | Action |
|--------|---------|--------|
| `PENDING` | Job is queued, not yet started | Report status; check again later |
| `PROCESSING` | AI is actively working | Report status; check again later |
| `FINISHED` | Complete — result is ready | Extract and present `result_image_url` |
| `FAILED` | Processing encountered an error | Report the error; ask user whether to resubmit |

## Polling guidance
Most jobs finish in **30–60 seconds**; large or complex images can take several minutes.

Run this command **once per check** — do not loop on it. You cannot wait out a wall-clock
interval mid-turn, and repeated back-to-back calls only add API load without advancing the
job. If a job is still `PENDING` or `PROCESSING`, report that and either end your turn or
continue with other work; check again on a later turn or when the user asks.

If the user wants to avoid checking altogether, submit the original job with
`--callback <URL>` and let the webhook notify them (see `automation-get-webhook-public-key`
for verifying the signature).

## Success Criteria
- When `FINISHED`: present the `result_image_url` as a direct download link.
- When `FAILED`: report the error message from the response clearly. Do not retry automatically — ask the user if they want to resubmit, potentially with adjusted parameters.
- When still in progress: report the current status and roughly how long the job has been running.
---
