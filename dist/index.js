// index.ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

// src/channel.ts
import crypto from "node:crypto";
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
var recentInbound = /* @__PURE__ */ new Map();
var processedInbound = /* @__PURE__ */ new Map();
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
function rememberInboundSms(msg) {
  const key = msg.messageSid ?? `${msg.from}:${Date.now()}`;
  recentInbound.set(key, msg);
  while (recentInbound.size > MAX_TRACKED_ITEMS) {
    const oldestKey = recentInbound.keys().next().value;
    if (!oldestKey) break;
    recentInbound.delete(oldestKey);
  }
}
function markInboundSmsSeen(messageSid, now = Date.now()) {
  if (!messageSid) return false;
  pruneMapByAge(processedInbound, (timestamp) => timestamp, now);
  if (processedInbound.has(messageSid)) return true;
  processedInbound.set(messageSid, now);
  return false;
}
function rememberOutboundSmsStatus(status) {
  outboundStatuses.set(status.sid, status);
  pruneMapByAge(outboundStatuses, (item) => item.updatedAt, status.updatedAt);
}
function listRecentOutboundSmsStatuses() {
  return Array.from(outboundStatuses.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

// src/runtime.ts
function getTwilioSmsRuntimeContext(accountId) {
  const runtime = getTwilioSmsRuntime();
  if (!runtime?.channel || !runtime?.config) return void 0;
  const loadedCfg = typeof runtime.config.loadConfig === "function" ? runtime.config.loadConfig() : runtime.config;
  return {
    cfg: loadedCfg,
    accountId: accountId ?? null,
    core: runtime,
    runtimeStoreName: loadedCfg?.session?.store
  };
}

// src/channel.ts
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
function registerTwilioSmsWebhook(api) {
  const cfg = api.runtime?.config?.loadConfig?.();
  const account = resolveAccount(cfg ?? {});
  api.registerHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const raw = await readRequestBody(req);
        const form = new URLSearchParams(raw);
        const from = form.get("From") ?? "";
        const to = form.get("To") ?? "";
        const body = form.get("Body") ?? "";
        const messageSid = form.get("MessageSid");
        const accountId = null;
        const runtimeCtx = getTwilioSmsRuntimeContext(accountId);
        if (!runtimeCtx) throw new Error("twilio-sms-bridge runtime context unavailable");
        const runtimeAccount = resolveAccount(runtimeCtx.cfg, runtimeCtx.accountId ?? void 0);
        validateTwilioWebhookSignature(req, runtimeAccount, form, runtimeAccount.webhookPath);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/xml");
        res.end("<Response></Response>");
        if (markInboundSmsSeen(messageSid)) {
          console.log("[twilio-sms-bridge] duplicate inbound webhook ignored", { from, to, messageSid });
          return true;
        }
        void processInboundSms({ from, to, body, messageSid, accountId, runtimeCtx }).catch((error) => {
          console.error("[twilio-sms-bridge] inbound processing failed", {
            error: error instanceof Error ? error.message : String(error),
            from,
            to,
            messageSid
          });
        });
        return true;
      } catch (error) {
        console.error("[twilio-sms-bridge] webhook request failed", error);
        res.statusCode = error instanceof Error && error.message.includes("invalid Twilio signature") ? 403 : 200;
        res.setHeader("Content-Type", "text/xml");
        res.end("<Response></Response>");
        return true;
      }
    }
  });
  api.registerHttpRoute({
    path: account.statusCallbackPath,
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const raw = await readRequestBody(req);
        const form = new URLSearchParams(raw);
        const accountId = null;
        const runtimeCtx = getTwilioSmsRuntimeContext(accountId);
        if (!runtimeCtx) throw new Error("twilio-sms-bridge runtime context unavailable");
        const runtimeAccount = resolveAccount(runtimeCtx.cfg, runtimeCtx.accountId ?? void 0);
        validateTwilioWebhookSignature(req, runtimeAccount, form, runtimeAccount.statusCallbackPath);
        const sid = form.get("MessageSid") ?? form.get("SmsSid");
        if (sid) {
          rememberOutboundSmsStatus({
            sid,
            to: form.get("To") ?? void 0,
            from: form.get("From") ?? void 0,
            status: form.get("MessageStatus") ?? form.get("SmsStatus") ?? void 0,
            errorCode: form.get("ErrorCode"),
            errorMessage: form.get("ErrorMessage"),
            updatedAt: Date.now()
          });
        }
        res.statusCode = 204;
        res.end();
        return true;
      } catch (error) {
        console.error("[twilio-sms-bridge] status callback failed", error);
        res.statusCode = error instanceof Error && error.message.includes("invalid Twilio signature") ? 403 : 204;
        res.end();
        return true;
      }
    }
  });
}
async function processInboundSms({
  from,
  to,
  body,
  messageSid,
  accountId,
  runtimeCtx
}) {
  rememberInboundSms({ from, to, body, messageSid });
  console.log("[twilio-sms-bridge] inbound webhook received", { from, to, messageSid, bodyLength: body.length });
  const resolvedRuntimeCtx = runtimeCtx ?? getTwilioSmsRuntimeContext(accountId);
  if (!resolvedRuntimeCtx) throw new Error("twilio-sms-bridge runtime context unavailable");
  const runtime = resolvedRuntimeCtx.core;
  const channel = runtime.channel;
  const cfg = resolvedRuntimeCtx.cfg;
  const route = channel.routing.resolveAgentRoute({
    cfg,
    channel: "twilio-sms-bridge",
    accountId: resolvedRuntimeCtx.accountId ?? void 0,
    peer: { kind: "direct", id: from }
  });
  const storePath = channel.session.resolveStorePath(resolvedRuntimeCtx.runtimeStoreName ?? cfg.session?.store, {
    agentId: route.agentId
  });
  const previousTimestamp = channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const timestamp = Date.now();
  const formattedBody = channel.reply.formatAgentEnvelope({
    channel: "twilio-sms-bridge",
    from,
    timestamp,
    previousTimestamp,
    envelope: channel.reply.resolveEnvelopeFormatOptions(cfg),
    body
  });
  const smsInstruction = [
    "[SMS reply mode]",
    "Keep replies concise and brief.",
    "Use plain text. ASCII when possible.",
    "No emoji. No markdown. No smart punctuation.",
    "No filler. No intro. No outro.",
    "No follow-up offers unless asked.",
    "Answer only the core request; include extra detail only when needed.",
    ""
  ].join("\n");
  const ctxPayload = channel.reply.finalizeInboundContext({
    Body: formattedBody,
    BodyForAgent: body,
    GroupSystemPrompt: smsInstruction.trim(),
    RawBody: body,
    CommandBody: body,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? resolvedRuntimeCtx.accountId ?? void 0,
    ChatType: "direct",
    ConversationLabel: from,
    NativeChannelId: from,
    SenderName: from,
    SenderId: from,
    Provider: "twilio-sms-bridge",
    Surface: "twilio-sms-bridge",
    MessageSid: messageSid ?? void 0,
    MessageSidFull: messageSid ?? void 0,
    Timestamp: timestamp,
    OriginatingChannel: "twilio-sms-bridge",
    OriginatingTo: from,
    CommandAuthorized: true
  });
  await dispatchInboundReplyWithBase({
    cfg,
    channel: "twilio-sms-bridge",
    accountId: resolvedRuntimeCtx.accountId ?? void 0,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      const text = payload && typeof payload === "object" && "text" in payload ? String(payload.text ?? "") : "";
      if (!text.trim()) return;
      const account = resolveAccount(cfg, resolvedRuntimeCtx.accountId ?? void 0);
      console.log("[twilio-sms-bridge] sending outbound sms", { to: from, messageSid, textLength: text.length });
      const result = await sendTwilioSms(withStatusCallbackUrl(account), from, text);
      if (result.sid) {
        rememberOutboundSmsStatus({
          sid: result.sid,
          to: from,
          from: account.fromNumber,
          status: "queued",
          updatedAt: Date.now()
        });
      }
      console.log("[twilio-sms-bridge] outbound sms sent", { to: from, messageSid, sid: result.sid });
    },
    onRecordError: (error) => {
      throw error instanceof Error ? error : new Error(`twilio-sms-bridge session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error ? error : new Error(`twilio-sms-bridge dispatch failed: ${String(error)}`);
    }
  });
  console.log("[twilio-sms-bridge] inbound processing complete", { from, to, messageSid, sessionKey: route.sessionKey });
}
function validateTwilioWebhookSignature(req, account, params, path) {
  if (!account.publicBaseUrl) throw new Error("twilio-sms-bridge: publicBaseUrl is required for signature validation");
  const signature = String(req.headers?.["x-twilio-signature"] ?? "");
  if (!signature) throw new Error("twilio-sms-bridge: missing X-Twilio-Signature header");
  const url = new URL(path, account.publicBaseUrl).toString();
  const expected = crypto.createHmac("sha1", account.authToken.trim()).update(buildTwilioDataToSign(url, params)).digest("base64");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) {
    throw new Error("twilio-sms-bridge: invalid Twilio signature");
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("twilio-sms-bridge: invalid Twilio signature");
  }
}
function withStatusCallbackUrl(account) {
  if (!account.publicBaseUrl) return account;
  return {
    ...account,
    statusCallbackUrl: new URL(account.statusCallbackPath, account.publicBaseUrl).toString()
  };
}
function buildTwilioDataToSign(url, params) {
  let dataToSign = url;
  const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of sortedParams) dataToSign += key + value;
  return dataToSign;
}
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// index.ts
var index_default = defineChannelPluginEntry({
  id: "twilio-sms-bridge",
  name: "Twilio SMS Bridge",
  description: "Custom SMS channel plugin for OpenClaw via Twilio",
  plugin: twilioSmsBridgePlugin,
  setRuntime: setTwilioSmsRuntime,
  registerFull(api) {
    registerTwilioSmsWebhook(api);
  }
});
export {
  index_default as default
};
