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

The response looks like
`{"job_type": "...", "status": {"status_code": 4, "status_name": "Completed"}, "result": {"result_image_url": "...", "result_trimap_vector_url": null}}`.
Read `status.status_name` (or `status.status_code`):

| Code | `status_name` | Meaning | Action |
|------|---------------|---------|--------|
| 1 | `Created` | Job accepted, not yet queued | Report status; check again later |
| 2 | `ReadyForProcess` | Queued for processing | Report status; check again later |
| 3 | `Processing` | AI is actively working | Report status; check again later |
| 4 | `Completed` | Complete — result is ready | Extract and present `result.result_image_url` |
| 5 | `Delivered` | Complete — result was delivered (e.g. via webhook) | Same as `Completed` |
| 6 | `Failed` | Processing encountered an error | Report the error; ask user whether to resubmit |

## Polling guidance
Most jobs finish in **30–60 seconds**; large or complex images can take several minutes.

Run this command **once per check** — do not loop on it. You cannot wait out a wall-clock
interval mid-turn, and repeated back-to-back calls only add API load without advancing the
job. If a job is still `Created`, `ReadyForProcess` or `Processing`, report that and either end your turn or
continue with other work; check again on a later turn or when the user asks.

If the user wants to avoid checking altogether, submit the original job with
`--callback <URL>` and let the webhook notify them (see `automation-get-webhook-public-key`
for verifying the signature).

## Success Criteria
- When `Completed` or `Delivered`: present `result.result_image_url` as a direct download link.
- When `Failed`: report the error message from the response clearly. Do not retry automatically — ask the user if they want to resubmit, potentially with adjusted parameters.
- When still in progress: report the current status and roughly how long the job has been running.
---
