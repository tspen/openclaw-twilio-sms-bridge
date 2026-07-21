import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccount } from "../src/config.ts";

test("resolveAccount supports channel config with dmPolicy", () => {
  assert.deepEqual(
    resolveAccount({
      channels: {
        "twilio-sms-bridge": {
          accountSid: "AC_CHANNEL",
          authToken: "channel-secret",
          fromNumber: "+15550000000",
          publicBaseUrl: "https://example.com",
          allowFrom: ["+15551111111"],
          dmPolicy: "allowlist",
        },
      },
    }),
    {
      accountId: null,
      accountSid: "AC_CHANNEL",
      authToken: "channel-secret",
      fromNumber: "+15550000000",
      webhookPath: "/twilio-sms/webhook",
      statusCallbackPath: "/twilio-sms/status",
      publicBaseUrl: "https://example.com",
      allowFrom: ["+15551111111"],
      dmPolicy: "allowlist",
    },
  );
});

test("resolveAccount supports legacy plugin config with dmSecurity", () => {
  const account = resolveAccount({
    plugins: {
      entries: {
        "twilio-sms-bridge": {
          config: {
            accountSid: "AC_LEGACY",
            authToken: "legacy-secret",
            fromNumber: "+15550000000",
            dmSecurity: "pairing",
          },
        },
      },
    },
  });

  assert.equal(account.accountSid, "AC_LEGACY");
  assert.equal(account.dmPolicy, "pairing");
});

test("resolveAccount lets channel config override legacy plugin config", () => {
  const account = resolveAccount({
    plugins: {
      entries: {
        "twilio-sms-bridge": {
          config: {
            accountSid: "AC_LEGACY",
            authToken: "legacy-secret",
            fromNumber: "+15550000000",
            webhookPath: "/legacy-webhook",
            dmSecurity: "pairing",
          },
        },
      },
    },
    channels: {
      "twilio-sms-bridge": {
        accountSid: "AC_CHANNEL",
        authToken: "channel-secret",
        fromNumber: "+15552222222",
        statusCallbackPath: "/channel-status",
        dmPolicy: "open",
      },
    },
  });

  assert.equal(account.accountSid, "AC_CHANNEL");
  assert.equal(account.authToken, "channel-secret");
  assert.equal(account.fromNumber, "+15552222222");
  assert.equal(account.webhookPath, "/legacy-webhook");
  assert.equal(account.statusCallbackPath, "/channel-status");
  assert.equal(account.dmPolicy, "open");
});
