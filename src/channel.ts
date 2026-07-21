import crypto from "node:crypto";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  createChannelPluginBase,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  createTopLevelChannelConfigAdapter,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter,
} from "openclaw/plugin-sdk/status-helpers";
import { sendTwilioSms } from "./client.js";
import {
  getTwilioSmsRuntimeContext,
  listRecentOutboundSmsStatuses,
  markInboundSmsSeen,
  rememberInboundSms,
  rememberOutboundSmsStatus,
} from "./runtime.js";

type ResolvedAccount = {
  accountId: string | null;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookPath: string;
  statusCallbackPath: string;
  publicBaseUrl?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

function resolveAccountAllowFrom(account: any): string[] {
  return account?.allowFrom ?? account?.config?.allowFrom ?? [];
}

function resolveAccountDmPolicy(account: any): string | undefined {
  return account?.dmPolicy ?? account?.dmSecurity ?? account?.config?.dmPolicy ?? account?.config?.dmSecurity;
}

function resolveLegacyPluginSection(cfg: OpenClawConfig): Record<string, any> {
  return (((cfg as Record<string, any>)?.plugins?.entries?.["twilio-sms-bridge"]?.config ?? {}) as Record<string, any>);
}

function resolveChannelSection(cfg: OpenClawConfig): Record<string, any> {
  return (((cfg as Record<string, any>)?.channels?.["twilio-sms-bridge"] ?? {}) as Record<string, any>);
}

function resolveSection(cfg: OpenClawConfig): Record<string, any> {
  const legacy = resolveLegacyPluginSection(cfg);
  const channel = resolveChannelSection(cfg);
  return { ...legacy, ...channel };
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
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
    dmPolicy: section.dmPolicy ?? section.dmSecurity,
  };
}

function normalizePhoneTarget(raw: string): string | null {
  const stripped = stripTargetKindPrefix(stripChannelTargetPrefix(raw, "twilio-sms-bridge", "twilio", "sms")).trim();
  const normalized = stripped.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(normalized)) return normalized;
  if (/^\d{8,15}$/.test(normalized)) return `+${normalized}`;
  return null;
}

const twilioSmsConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedAccount>({
  sectionKey: "twilio-sms-bridge",
  resolveAccount,
  inspectAccount(cfg) {
    const section = resolveSection(cfg);
    return {
      enabled: Boolean(section.enabled ?? true),
      configured: Boolean(section.accountSid && section.authToken && section.fromNumber),
      accountSidStatus: section.accountSid ? "available" : "missing",
      authTokenStatus: section.authToken ? "available" : "missing",
      fromNumberStatus: section.fromNumber ? "available" : "missing",
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
    "dmSecurity",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: formatTrimmedAllowFromEntries,
});

export const twilioSmsBridgePlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    ...createChannelPluginBase({
      id: "twilio-sms-bridge",
      capabilities: {
        chatTypes: ["direct"],
      },
      config: twilioSmsConfigAdapter,
      setup: {
        resolveAccount,
        inspectAccount: twilioSmsConfigAdapter.inspectAccount,
      },
    }),
    messaging: {
      inferTargetChatType: ({ to }) => (normalizePhoneTarget(to) ? "direct" : undefined),
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
            source: "normalized",
          };
        },
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
          threadId: params.threadId ?? undefined,
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedAccount>({
      buildChannelSummary: ({ snapshot }) =>
        buildWebhookChannelStatusSummary(snapshot, { mode: "webhook" }),
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
          recentDeliveryStatuses: listRecentOutboundSmsStatuses().slice(0, 5),
        },
      }),
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
      const account = resolveAccount(cfg, accountId);
      return {
        policy: account.dmPolicy ?? "allowlist",
        allowFrom: account.allowFrom,
        policyPath: "channels.twilio-sms-bridge.dmPolicy",
        allowFromPath: "channels.twilio-sms-bridge.",
        approveHint:
          "Approve via: openclaw pairing list twilio-sms-bridge / openclaw pairing approve twilio-sms-bridge <code>",
      };
    },
  },
  pairing: {
    text: {
      idLabel: "phone number",
      message: "Reply with this pairing code to verify your SMS identity:",
      notify: async ({ target, code, account }) => {
        await sendTwilioSms(account, target, `Pairing code: ${code}`);
      },
    },
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: "twilio-sms-bridge",
      sendText: async (params) => {
        const account = resolveAccount(params.cfg, params.accountId ?? undefined);
        const result = await sendTwilioSms(withStatusCallbackUrl(account), params.to, params.text);
        if (result.sid) {
          rememberOutboundSmsStatus({
            sid: result.sid,
            to: params.to,
            from: account.fromNumber,
            status: "queued",
            updatedAt: Date.now(),
          });
        }
        return { messageId: result.sid ?? undefined };
      },
    },
  },
});

export function registerTwilioSmsWebhook(api: any): void {
  const cfg = api.runtime?.config?.loadConfig?.();
  const account = resolveAccount(cfg ?? ({} as OpenClawConfig));

  api.registerHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    handler: async (req: any, res: any) => {
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
        const runtimeAccount = resolveAccount(runtimeCtx.cfg, runtimeCtx.accountId ?? undefined);

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
            messageSid,
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
    },
  });

  api.registerHttpRoute({
    path: account.statusCallbackPath,
    auth: "plugin",
    handler: async (req: any, res: any) => {
      try {
        const raw = await readRequestBody(req);
        const form = new URLSearchParams(raw);
        const accountId = null;
        const runtimeCtx = getTwilioSmsRuntimeContext(accountId);
        if (!runtimeCtx) throw new Error("twilio-sms-bridge runtime context unavailable");
        const runtimeAccount = resolveAccount(runtimeCtx.cfg, runtimeCtx.accountId ?? undefined);

        validateTwilioWebhookSignature(req, runtimeAccount, form, runtimeAccount.statusCallbackPath);

        const sid = form.get("MessageSid") ?? form.get("SmsSid");
        if (sid) {
          rememberOutboundSmsStatus({
            sid,
            to: form.get("To") ?? undefined,
            from: form.get("From") ?? undefined,
            status: form.get("MessageStatus") ?? form.get("SmsStatus") ?? undefined,
            errorCode: form.get("ErrorCode"),
            errorMessage: form.get("ErrorMessage"),
            updatedAt: Date.now(),
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
    },
  });
}

async function processInboundSms({
  from,
  to,
  body,
  messageSid,
  accountId,
  runtimeCtx,
}: {
  from: string;
  to: string;
  body: string;
  messageSid: string | null;
  accountId?: string | null;
  runtimeCtx?: ReturnType<typeof getTwilioSmsRuntimeContext>;
}): Promise<void> {
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
    accountId: resolvedRuntimeCtx.accountId ?? undefined,
    peer: { kind: "direct", id: from },
  });
  const storePath = channel.session.resolveStorePath(resolvedRuntimeCtx.runtimeStoreName ?? cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const timestamp = Date.now();
  const formattedBody = channel.reply.formatAgentEnvelope({
    channel: "twilio-sms-bridge",
    from,
    timestamp,
    previousTimestamp,
    envelope: channel.reply.resolveEnvelopeFormatOptions(cfg),
    body,
  });
  const smsInstruction = [
    "[SMS reply mode]",
    "Keep replies concise and brief.",
    "Use plain text. ASCII when possible.",
    "No emoji. No markdown. No smart punctuation.",
    "No filler. No intro. No outro.",
    "No follow-up offers unless asked.",
    "Answer only the core request; include extra detail only when needed.",
    "",
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
    AccountId: route.accountId ?? resolvedRuntimeCtx.accountId ?? undefined,
    ChatType: "direct",
    ConversationLabel: from,
    NativeChannelId: from,
    SenderName: from,
    SenderId: from,
    Provider: "twilio-sms-bridge",
    Surface: "twilio-sms-bridge",
    MessageSid: messageSid ?? undefined,
    MessageSidFull: messageSid ?? undefined,
    Timestamp: timestamp,
    OriginatingChannel: "twilio-sms-bridge",
    OriginatingTo: from,
    CommandAuthorized: true,
  });

  await dispatchInboundReplyWithBase({
    cfg,
    channel: "twilio-sms-bridge",
    accountId: resolvedRuntimeCtx.accountId ?? undefined,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      const text = payload && typeof payload === "object" && "text" in payload ? String(payload.text ?? "") : "";
      if (!text.trim()) return;
      const account = resolveAccount(cfg, resolvedRuntimeCtx.accountId ?? undefined);
      console.log("[twilio-sms-bridge] sending outbound sms", { to: from, messageSid, textLength: text.length });
      const result = await sendTwilioSms(withStatusCallbackUrl(account), from, text);
      if (result.sid) {
        rememberOutboundSmsStatus({
          sid: result.sid,
          to: from,
          from: account.fromNumber,
          status: "queued",
          updatedAt: Date.now(),
        });
      }
      console.log("[twilio-sms-bridge] outbound sms sent", { to: from, messageSid, sid: result.sid });
    },
    onRecordError: (error) => {
      throw error instanceof Error ? error : new Error(`twilio-sms-bridge session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error ? error : new Error(`twilio-sms-bridge dispatch failed: ${String(error)}`);
    },
  });

  console.log("[twilio-sms-bridge] inbound processing complete", { from, to, messageSid, sessionKey: route.sessionKey });
}

function validateTwilioWebhookSignature(req: any, account: ResolvedAccount, params: URLSearchParams, path: string): void {
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

function withStatusCallbackUrl(account: ResolvedAccount): ResolvedAccount & { statusCallbackUrl?: string } {
  if (!account.publicBaseUrl) return account;
  return {
    ...account,
    statusCallbackUrl: new URL(account.statusCallbackPath, account.publicBaseUrl).toString(),
  };
}

function buildTwilioDataToSign(url: string, params: URLSearchParams): string {
  let dataToSign = url;
  const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of sortedParams) dataToSign += key + value;
  return dataToSign;
}

async function readRequestBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
