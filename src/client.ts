export type TwilioSmsConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

const MAX_SMS_SEGMENTS = 2;
const GSM_SINGLE_SEGMENT = 160;
const GSM_MULTI_SEGMENT = 153;
const SAFE_SMS_MAX_LEN = GSM_MULTI_SEGMENT * MAX_SMS_SEGMENTS;

function normalizeSmsText(body: string): string {
  return body
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSmsText(body: string): string[] {
  const normalized = normalizeSmsText(body);
  if (!normalized) return [];
  if (normalized.length <= GSM_SINGLE_SEGMENT) return [normalized];

  const truncated = normalized.length > SAFE_SMS_MAX_LEN
    ? `${normalized.slice(0, SAFE_SMS_MAX_LEN - 3).trimEnd()}...`
    : normalized;

  const chunks: string[] = [];
  let remaining = truncated;
  while (remaining.length > 0) {
    if (remaining.length <= GSM_MULTI_SEGMENT) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", GSM_MULTI_SEGMENT);
    if (splitAt < Math.floor(GSM_MULTI_SEGMENT * 0.6)) splitAt = remaining.lastIndexOf(" ", GSM_MULTI_SEGMENT);
    if (splitAt < Math.floor(GSM_MULTI_SEGMENT * 0.6)) splitAt = GSM_MULTI_SEGMENT;

    const chunk = remaining.slice(0, splitAt).trim();
    chunks.push(chunk || remaining.slice(0, GSM_MULTI_SEGMENT));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks.filter(Boolean).slice(0, MAX_SMS_SEGMENTS);
}

export async function sendTwilioSms(
  cfg: TwilioSmsConfig,
  to: string,
  body: string,
): Promise<{ sid: string | null }> {
  const accountSid = cfg.accountSid.trim();
  const authToken = cfg.authToken.trim();
  const fromNumber = cfg.fromNumber.trim();
  const parts = splitSmsText(body);
  if (!parts.length) return { sid: null };

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  let lastSid: string | null = null;

  for (const part of parts) {
    const params = new URLSearchParams();
    params.set("To", to);
    params.set("From", fromNumber);
    params.set("Body", part);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`twilio sms send failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as { sid?: string };
    lastSid = json.sid ?? null;
  }

  return { sid: lastSid };
}
