// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

// src/channel.ts
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  createChannelPluginBase,
  stripChannelTargetPrefix,
  stripTargetKindPrefix
} from "openclaw/plugin-sdk/channel-core";
import {
  createTopLevelChannelConfigAdapter,
  formatTrimmedAllowFromEntries
} from "openclaw/plugin-sdk/channel-config-helpers";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter
} from "openclaw/plugin-sdk/status-helpers";

// src/config.ts
function resolveLegacyPluginSection(cfg) {
  return cfg?.plugins?.entries?.["twilio-sms-bridge"]?.config ?? {};
}
function resolveChannelSection(cfg) {
  return cfg?.channels?.["twilio-sms-bridge"] ?? {};
}
function resolveSection(cfg) {
  const legacy = resolveLegacyPluginSection(cfg);
  const channel = resolveChannelSection(cfg);
  return { ...legacy, ...channel };
}
function resolveAccount(cfg, accountId) {
  const section = resolveSection(cfg);
  if (!section.accountSid) throw new Error("twilio-sms-bridge: accountSid is required");
  if (!section.authToken) throw new Error("twilio-sms-bridge: authToken is required");
  if (!section.fromNumber) throw new Error("twilio-sms-bridge: fromNumber is required");
  return {
    accountId: accountId ?? null,
    accountSid: section.accountSid,
    authToken: section.authToken,
    fromNumber: section.fromNumber,
    webhookPath: section.webhookPath ?? "/twilio-sms/webhook",
    statusCallbackPath: section.statusCallbackPath ?? "/twilio-sms/status",
    publicBaseUrl: section.publicBaseUrl,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmPolicy ?? section.dmSecurity
  };
}

// src/client.ts
var TwilioSmsSendError = class extends Error {
  status;
  responseBody;
  retryable;
  constructor(message, opts) {
    super(message);
    this.name = "TwilioSmsSendError";
    this.status = opts.status;
    this.responseBody = opts.responseBody;
    this.retryable = opts.retryable;
  }
};
var GSM_SINGLE_SEGMENT = 160;
var GSM_MULTI_SEGMENT = 153;
function normalizeSmsText(body) {
  return body.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function splitSmsText(body) {
  const normalized = normalizeSmsText(body);
  return normalized ? [normalized] : [];
}
function estimateSmsParts(body) {
  if (!body) return 0;
  if (body.length <= GSM_SINGLE_SEGMENT) return 1;
  return Math.ceil(body.length / GSM_MULTI_SEGMENT);
}
function isRetryableTwilioStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function sendTwilioSms(cfg, to, body, options = {}) {
  const accountSid = cfg.accountSid.trim();
  const authToken = cfg.authToken.trim();
  const fromNumber = cfg.fromNumber.trim();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
  const parts = splitSmsText(body);
  if (!parts.length) return { sid: null };
  const normalized = normalizeSmsText(body);
  console.log("[twilio-sms-bridge] sms output prepared", {
    originalLength: body.length,
    normalizedLength: normalized.length,
    estimatedParts: estimateSmsParts(normalized),
    actualParts: parts.length
  });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  let lastSid = null;
  for (const part of parts) {
    const params = new URLSearchParams();
    params.set("To", to);
    params.set("From", fromNumber);
    params.set("Body", part);
    if (cfg.statusCallbackUrl) params.set("StatusCallback", cfg.statusCallbackUrl);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params
          }
        );
        if (!res.ok) {
          const text = await res.text();
          const retryable = isRetryableTwilioStatus(res.status);
          if (retryable && attempt < maxAttempts) {
            await sleep(retryDelayMs * attempt);
            continue;
          }
          throw new TwilioSmsSendError(`twilio sms send failed: ${res.status} ${text}`, {
            status: res.status,
            responseBody: text,
            retryable
          });
        }
        const json = await res.json();
        lastSid = json.sid ?? null;
        break;
      } catch (error) {
        if (error instanceof TwilioSmsSendError) throw error;
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new TwilioSmsSendError(`twilio sms send failed: ${error instanceof Error ? error.message : String(error)}`, {
          retryable: true
        });
      }
    }
  }
  return { sid: lastSid };
}

// src/runtime-store.ts
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
var { setRuntime: setTwilioSmsRuntime, getRuntime: getTwilioSmsRuntime } = createPluginRuntimeStore("Twilio SMS runtime not initialized");

// src/state.ts
var outboundStatuses = /* @__PURE__ */ new Map();
var TRACKED_ITEM_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_TRACKED_ITEMS = 200;
function pruneMapByAge(map, readTimestamp, now = Date.now()) {
  for (const [key, item] of map) {
    if (now - readTimestamp(item) > TRACKED_ITEM_TTL_MS) map.delete(key);
  }
  while (map.size > MAX_TRACKED_ITEMS) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}
function rememberOutboundSmsStatus(status) {
  outboundStatuses.set(status.sid, status);
  pruneMapByAge(outboundStatuses, (item) => item.updatedAt, status.updatedAt);
}
function listRecentOutboundSmsStatuses() {
  return Array.from(outboundStatuses.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

// src/channel.ts
function normalizePhoneTarget(raw) {
  const stripped = stripTargetKindPrefix(stripChannelTargetPrefix(raw, "twilio-sms-bridge", "twilio", "sms")).trim();
  const normalized = stripped.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(normalized)) return normalized;
  if (/^\d{8,15}$/.test(normalized)) return `+${normalized}`;
  return null;
}
var twilioSmsConfigAdapter = createTopLevelChannelConfigAdapter({
  sectionKey: "twilio-sms-bridge",
  resolveAccount,
  inspectAccount(cfg) {
    const section = resolveSection(cfg);
    return {
      enabled: Boolean(section.enabled ?? true),
      configured: Boolean(section.accountSid && section.authToken && section.fromNumber),
      accountSidStatus: section.accountSid ? "available" : "missing",
      authTokenStatus: section.authToken ? "available" : "missing",
      fromNumberStatus: section.fromNumber ? "available" : "missing"
    };
  },
  deleteMode: "clear-fields",
  clearBaseFields: [
    "name",
    "enabled",
    "accountSid",
    "authToken",
    "fromNumber",
    "publicBaseUrl",
    "webhookPath",
    "statusCallbackPath",
    "allowFrom",
    "dmPolicy",
    "dmSecurity"
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: formatTrimmedAllowFromEntries
});
var twilioSmsBridgePlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: "twilio-sms-bridge",
      capabilities: {
        chatTypes: ["direct"]
      },
      config: twilioSmsConfigAdapter,
      setup: {
        resolveAccount,
        inspectAccount: twilioSmsConfigAdapter.inspectAccount
      }
    }),
    messaging: {
      inferTargetChatType: ({ to }) => normalizePhoneTarget(to) ? "direct" : void 0,
      targetResolver: {
        looksLikeId: (raw) => Boolean(normalizePhoneTarget(raw)),
        hint: "+15551234567",
        resolveTarget: async ({ input, normalized }) => {
          const target = normalizePhoneTarget(normalized || input);
          if (!target) return null;
          return {
            to: target,
            kind: "user",
            display: target,
            source: "normalized"
          };
        }
      },
      resolveOutboundSessionRoute: (params) => {
        const target = normalizePhoneTarget(params.resolvedTarget?.to ?? params.target);
        if (!target) return null;
        return buildChannelOutboundSessionRoute({
          cfg: params.cfg,
          agentId: params.agentId,
          channel: "twilio-sms-bridge",
          accountId: params.accountId,
          peer: { kind: "direct", id: target },
          chatType: "direct",
          from: `twilio-sms-bridge:${target}`,
          to: target,
          threadId: params.threadId ?? void 0
        });
      }
    },
    status: createComputedAccountStatusAdapter({
      buildChannelSummary: ({ snapshot }) => buildWebhookChannelStatusSummary(snapshot, { mode: "webhook" }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId ?? "default",
        enabled: true,
        configured: true,
        extra: {
          mode: "webhook",
          running: true,
          connected: true,
          healthState: "ok",
          webhookPath: account.webhookPath,
          statusCallbackPath: account.statusCallbackPath,
          recentDeliveryStatuses: listRecentOutboundSmsStatuses().slice(0, 5)
        }
      })
    })
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId }) => {
      const account = resolveAccount(cfg, accountId);
      return {
        policy: account.dmPolicy ?? "allowlist",
        allowFrom: account.allowFrom,
        policyPath: "channels.twilio-sms-bridge.dmPolicy",
        allowFromPath: "channels.twilio-sms-bridge.",
        approveHint: "Approve via: openclaw pairing list twilio-sms-bridge / openclaw pairing approve twilio-sms-bridge <code>"
      };
    }
  },
  pairing: {
    text: {
      idLabel: "phone number",
      message: "Reply with this pairing code to verify your SMS identity:",
      notify: async ({ target, code, account }) => {
        await sendTwilioSms(account, target, `Pairing code: ${code}`);
      }
    }
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: "twilio-sms-bridge",
      sendText: async (params) => {
        const account = resolveAccount(params.cfg, params.accountId ?? void 0);
        const result = await sendTwilioSms(withStatusCallbackUrl(account), params.to, params.text);
        if (result.sid) {
          rememberOutboundSmsStatus({
            sid: result.sid,
            to: params.to,
            from: account.fromNumber,
            status: "queued",
            updatedAt: Date.now()
          });
        }
        return { messageId: result.sid ?? void 0 };
      }
    }
  }
});
function withStatusCallbackUrl(account) {
  if (!account.publicBaseUrl) return account;
  return {
    ...account,
    statusCallbackUrl: new URL(account.statusCallbackPath, account.publicBaseUrl).toString()
  };
}

// setup-entry.ts
var setup_entry_default = defineSetupPluginEntry(twilioSmsBridgePlugin);
export {
  setup_entry_default as default
};
