import crypto from "node:crypto";
import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { sendTwilioSms } from "./client.js";
import { getTwilioSmsRuntimeContext, rememberInboundSms } from "./runtime.js";

type ResolvedAccount = {
  accountId: string | null;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookPath: string;
  publicBaseUrl?: string;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

function resolveSection(cfg: OpenClawConfig): Record<string, any> {
  return (((cfg as Record<string, any>)?.plugins?.entries?.["twilio-sms-bridge"]?.config ?? {}) as Record<string, any>);
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
    publicBaseUrl: section.publicBaseUrl,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmSecurity,
  };
}

export const twilioSmsBridgePlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "twilio-sms-bridge",
    setup: {
      resolveAccount,
      inspectAccount(cfg) {
        const section = resolveSection(cfg);
        return {
          enabled: Boolean(section.accountSid && section.authToken && section.fromNumber),
          configured: Boolean(section.accountSid && section.authToken && section.fromNumber),
          accountSidStatus: section.accountSid ? "available" : "missing",
          authTokenStatus: section.authToken ? "available" : "missing",
          fromNumberStatus: section.fromNumber ? "available" : "missing",
        };
      },
    },
  }),
  security: {
    dm: {
      channelKey: "twilio-sms-bridge",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
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
    attachedResults: {
      sendText: async (params) => {
        const result = await sendTwilioSms(params.account, params.to, params.text);
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

        validateTwilioWebhookSignature(req, runtimeAccount, form);

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/xml");
        res.end("<Response></Response>");

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
    "Keep replies very short and plain.",
    "Use ASCII only when possible.",
    "Avoid emoji, markdown, smart quotes, and long explanations.",
    "Clarity matters more than grammar.",
    "If the answer is long, send a compressed version first.",
    "Aim for one to two short SMS segments max.",
    "",
  ].join("\n");

  const ctxPayload = channel.reply.finalizeInboundContext({
    Body: formattedBody,
    BodyForAgent: `${smsInstruction}${body}`,
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
    OriginatingTo: to,
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
      await sendTwilioSms(account, from, text);
      console.log("[twilio-sms-bridge] outbound sms sent", { to: from, messageSid });
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

function validateTwilioWebhookSignature(req: any, account: ResolvedAccount, params: URLSearchParams): void {
  if (!account.publicBaseUrl) throw new Error("twilio-sms-bridge: publicBaseUrl is required for signature validation");
  const signature = String(req.headers?.["x-twilio-signature"] ?? "");
  if (!signature) throw new Error("twilio-sms-bridge: missing X-Twilio-Signature header");
  const url = new URL(account.webhookPath, account.publicBaseUrl).toString();
  const expected = crypto.createHmac("sha1", account.authToken.trim()).update(buildTwilioDataToSign(url, params)).digest("base64");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("twilio-sms-bridge: invalid Twilio signature");
  }
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
