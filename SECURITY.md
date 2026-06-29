# Security

## Current security model

This plugin is intended to expose a Twilio inbound SMS webhook to OpenClaw over HTTPS.

Current protections:
- Twilio webhook signature validation using `X-Twilio-Signature`
- OpenClaw-side sender allowlist support through `allowFrom`
- asynchronous webhook acknowledgement to reduce timeout pressure
- plain-text-safe outbound SMS normalization

## Tool plugin access

Treat every approved SMS sender as able to ask the OpenClaw session to use any
tools available to that session. Before enabling this channel in a workspace with
tool plugins that can create public or account-changing actions, keep the SMS
entrypoint private:

- prefer `dmSecurity` / `dmPolicy` set to `allowlist` or `pairing`
- keep `allowFrom` limited to stable phone numbers you control
- keep OpenClaw approval prompts enabled for public-write tools
- bind this channel to a workspace that only has the tool permissions it needs

For example, if the workspace also installs
[`@xquik/tweetclaw`](https://github.com/Xquik-dev/tweetclaw), SMS messages could
ask the agent to search X/Twitter or prepare tweets through that plugin. Keep
TweetClaw posting and other public actions behind OpenClaw approvals unless every
allowed SMS sender is trusted to approve those actions.

## Required configuration

Set these fields in plugin config:

```json
{
  "accountSid": "AC...",
  "authToken": "...",
  "fromNumber": "+15551234567",
  "publicBaseUrl": "https://your-public-host.example.com",
  "webhookPath": "/twilio-sms/webhook",
  "allowFrom": ["+15557654321"],
  "dmSecurity": "allowlist"
}
```

Notes:
- `publicBaseUrl` must match the exact public HTTPS origin Twilio uses for webhook delivery.
- Signature validation will fail if the URL does not match what Twilio signed.
- Keep `authToken` secret and rotate it if exposed.

## Current limitations

This is still early-stage software. Recommended future improvements:
- replay protection for webhook deliveries
- structured audit logging
- test coverage for signature validation and outbound formatting
- rate limiting / abuse controls if exposed beyond a tight allowlist

## Reporting issues

If you share this publicly, add your preferred contact or issue-reporting path here.
