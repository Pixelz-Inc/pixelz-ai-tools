---
name: automation-get-webhook-public-key
description: Retrieve the ECDSA public key used to verify the authenticity of Pixelz Automation webhook payloads.
---

# Get Webhook Public Key (Pixelz Automation)

Pixelz signs every webhook notification with an ECDSA private key. Use this skill to fetch the matching public key so your application can verify that incoming webhooks are genuine and have not been tampered with.

## Command
```bash
node cli-tools/automation/node/cli.js get-key
```

## Why to use this
- To implement signature verification in your webhook receiver before trusting payload data.
- To rotate your locally stored public key if Pixelz issues a new one.

## How webhook verification works
1. Fetch the public key using this command and store it in your application.
2. When a webhook arrives, extract the `X-Pixelz-Signature` header.
3. Verify the signature against the raw request body using ECDSA SHA-256 and the stored public key.
4. Only process the payload if verification passes.

## Success Criteria
- Present the raw public key string to the user.
- Advise them to store it securely in their application's configuration (not in `.env`).
---
