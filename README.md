# Twilio SMS Bridge for OpenClaw

Custom channel plugin for talking to OpenClaw over plain SMS through Twilio.

## What this is

A working first-pass Twilio SMS channel plugin for OpenClaw.
It currently provides:
- plugin package structure
- channel plugin entrypoints
- plugin config schema
- inbound Twilio webhook handling
- OpenClaw session routing and reply dispatch
- outbound SMS sending through Twilio
- plain-text-safe SMS output normalization
- inbound webhook idempotency by Twilio `MessageSid`
- outbound delivery status callback tracking
- transient Twilio send retries with capped backoff

## Intended architecture

- Twilio receives SMS on a phone number you buy there
- Twilio sends inbound webhook requests to this plugin
- The plugin maps phone numbers to OpenClaw DM sessions
- OpenClaw generates replies
- The plugin sends replies back through Twilio SMS

## Current status

Working now:
- installable plugin package
- runtime registration
- inbound Twilio webhook route
- OpenClaw DM session routing by phone number
- asynchronous webhook ack to avoid Twilio timeouts
- duplicate inbound webhook suppression
- outbound Twilio SMS replies
- outbound Twilio delivery status callback route
- transient Twilio send retries
- plain-text-safe SMS output normalization
- conversation continuity through normal OpenClaw session handling
- tested with live Twilio traffic

Still worth doing:
- richer logging/metrics
- optional packaging/publishing cleanup

## Public sharing checklist

Done:
- no live credentials embedded in the plugin files
- public-friendly README and install instructions
- MIT license added
- sample config uses placeholder phone numbers

Before upstreaming or wider promotion, still recommended:
- expand integration tests around webhook routing
- add persistent storage for idempotency and delivery status if the gateway process is expected to restart often

## Files

- `package.json`
- `openclaw.plugin.json`
- `index.ts`
- `setup-entry.ts`
- `src/channel.ts`
- `src/client.ts`
- `src/runtime.ts`

## Install

```bash
openclaw plugins install /path/to/twilio-sms-bridge
openclaw gateway restart
```

Plugin config lives under:

```json
{
  "plugins": {
    "allow": ["twilio-sms-bridge"],
    "entries": {
      "twilio-sms-bridge": {
        "enabled": true,
        "config": {
          "accountSid": "AC...",
          "authToken": "...",
          "fromNumber": "+15551234567",
          "publicBaseUrl": "https://example.ts.net",
          "webhookPath": "/twilio-sms/webhook",
          "statusCallbackPath": "/twilio-sms/status",
          "allowFrom": ["+15557654321"],
          "dmPolicy": "allowlist"
        }
      }
    }
  }
}
```

## Suggested next steps

1. Keep Funnel running under a service, not a manual shell.
2. Add richer metrics/log summaries for delivery status and retry behavior.
3. Publish the plugin package somewhere durable if it should be installable outside this workspace.

## Twilio webhook shape

Twilio inbound SMS webhooks are `application/x-www-form-urlencoded` and usually include fields like:
- `From`
- `To`
- `Body`
- `MessageSid`

Outbound delivery status callbacks are handled at `statusCallbackPath` and usually include fields like:
- `MessageSid`
- `MessageStatus`
- `ErrorCode`
- `ErrorMessage`

## Security

See `SECURITY.md` for the security model and required `publicBaseUrl` setting used for Twilio signature validation.

## Caveat

The bridge is working in a real OpenClaw + Twilio setup, but I would still describe it as early-stage rather than production-hardened.
