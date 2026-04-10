# Security

## Current security model

This plugin is intended to expose a Twilio inbound SMS webhook to OpenClaw over HTTPS.

Current protections:
- Twilio webhook signature validation using `X-Twilio-Signature`
- OpenClaw-side sender allowlist support through `allowFrom`
- asynchronous webhook acknowledgement to reduce timeout pressure
- plain-text-safe outbound SMS normalization

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
