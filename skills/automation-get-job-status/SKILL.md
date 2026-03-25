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

| Status | Meaning | Action |
|--------|---------|--------|
| `PENDING` | Job is queued | Wait 30–60 seconds and poll again |
| `PROCESSING` | AI is actively working | Wait 30–60 seconds and poll again |
| `FINISHED` | Complete — result is ready | Extract and present `result_image_url` |
| `FAILED` | Processing encountered an error | Report the error; ask user whether to resubmit |

## Success Criteria
- When `FINISHED`: present the `result_image_url` as a direct download link.
- When `FAILED`: report the error message from the response clearly. Do not retry automatically — ask the user if they want to resubmit, potentially with adjusted parameters.
- When still in progress: tell the user the current status and that you will check again in 30–60 seconds.
---
