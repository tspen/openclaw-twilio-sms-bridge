import crypto from "node:crypto";
import {
  markInboundSmsSeen,
  rememberOutboundSmsStatus,
} from "./state.js";

export type TwilioWebhookAccount = {
  authToken: string;
  publicBaseUrl?: string;
  webhookPath: string;
  statusCallbackPath: string;
};

export type InboundWebhookPayload = {
  from: string;
  to: string;
  body: string;
  messageSid: string | null;
};

type RequestLike = AsyncIterable<Buffer | string | Uint8Array> & {
  headers?: Record<string, string | string[] | undefined>;
};

type ResponseLike = {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  end: (body?: string) => void;
};

export function buildTwilioDataToSign(url: string, params: URLSearchParams): string {
  let dataToSign = url;
  const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of sortedParams) dataToSign += key + value;
  return dataToSign;
}

export function buildTwilioRequestSignature(authToken: string, url: string, params: URLSearchParams): string {
  return crypto.createHmac("sha1", authToken.trim()).update(buildTwilioDataToSign(url, params)).digest("base64");
}

export function validateTwilioWebhookSignature(
  headers: Record<string, string | string[] | undefined> | undefined,
  account: TwilioWebhookAccount,
  params: URLSearchParams,
  path: string,
): void {
  if (!account.publicBaseUrl) throw new Error("twilio-sms-bridge: publicBaseUrl is required for signature validation");
  const rawSignature = headers?.["x-twilio-signature"];
  const signature = Array.isArray(rawSignature) ? rawSignature[0] : String(rawSignature ?? "");
  if (!signature) throw new Error("twilio-sms-bridge: missing X-Twilio-Signature header");
  const url = new URL(path, account.publicBaseUrl).toString();
  const expected = buildTwilioRequestSignature(account.authToken, url, params);
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) {
    throw new Error("twilio-sms-bridge: invalid Twilio signature");
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("twilio-sms-bridge: invalid Twilio signature");
  }
}

export async function readRequestBody(req: RequestLike): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function writeTwilioAck(res: ResponseLike): void {
  res.statusCode = 200;
  res.setHeader?.("Content-Type", "text/xml");
  res.end("<Response></Response>");
}

export async function handleInboundSmsWebhook({
  req,
  res,
  account,
  processInbound,
  onError,
}: {
  req: RequestLike;
  res: ResponseLike;
  account: TwilioWebhookAccount;
  processInbound: (payload: InboundWebhookPayload) => Promise<void>;
  onError?: (error: unknown, payload?: InboundWebhookPayload) => void;
}): Promise<boolean> {
  let payload: InboundWebhookPayload | undefined;
  try {
    const raw = await readRequestBody(req);
    const form = new URLSearchParams(raw);
    payload = {
      from: form.get("From") ?? "",
      to: form.get("To") ?? "",
      body: form.get("Body") ?? "",
      messageSid: form.get("MessageSid"),
    };

    validateTwilioWebhookSignature(req.headers, account, form, account.webhookPath);
    writeTwilioAck(res);

    if (markInboundSmsSeen(payload.messageSid)) return true;

    void processInbound(payload).catch((error) => onError?.(error, payload));
    return true;
  } catch (error) {
    onError?.(error, payload);
    res.statusCode = error instanceof Error && error.message.includes("invalid Twilio signature") ? 403 : 200;
    res.setHeader?.("Content-Type", "text/xml");
    res.end("<Response></Response>");
    return true;
  }
}

export async function handleStatusCallbackWebhook({
  req,
  res,
  account,
  now = Date.now(),
  onError,
}: {
  req: RequestLike;
  res: ResponseLike;
  account: TwilioWebhookAccount;
  now?: number;
  onError?: (error: unknown) => void;
}): Promise<boolean> {
  try {
    const raw = await readRequestBody(req);
    const form = new URLSearchParams(raw);
    validateTwilioWebhookSignature(req.headers, account, form, account.statusCallbackPath);

    const sid = form.get("MessageSid") ?? form.get("SmsSid");
    if (sid) {
      rememberOutboundSmsStatus({
        sid,
        to: form.get("To") ?? undefined,
        from: form.get("From") ?? undefined,
        status: form.get("MessageStatus") ?? form.get("SmsStatus") ?? undefined,
        errorCode: form.get("ErrorCode"),
        errorMessage: form.get("ErrorMessage"),
        updatedAt: now,
      });
    }

    res.statusCode = 204;
    res.end();
    return true;
  } catch (error) {
    onError?.(error);
    res.statusCode = error instanceof Error && error.message.includes("invalid Twilio signature") ? 403 : 204;
    res.end();
    return true;
  }
}
