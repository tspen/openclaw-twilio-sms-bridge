export type TwilioSmsConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  statusCallbackUrl?: string;
};

export type TwilioSmsSendOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
};

export class TwilioSmsSendError extends Error {
  readonly status?: number;
  readonly responseBody?: string;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; responseBody?: string; retryable: boolean }) {
    super(message);
    this.name = "TwilioSmsSendError";
    this.status = opts.status;
    this.responseBody = opts.responseBody;
    this.retryable = opts.retryable;
  }
}

const GSM_SINGLE_SEGMENT = 160;
const GSM_MULTI_SEGMENT = 153;

export function normalizeSmsText(body: string): string {
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

export function splitSmsText(body: string): string[] {
  const normalized = normalizeSmsText(body);
  return normalized ? [normalized] : [];
}

export function estimateSmsParts(body: string): number {
  if (!body) return 0;
  if (body.length <= GSM_SINGLE_SEGMENT) return 1;
  return Math.ceil(body.length / GSM_MULTI_SEGMENT);
}

export function isRetryableTwilioStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTwilioSms(
  cfg: TwilioSmsConfig,
  to: string,
  body: string,
  options: TwilioSmsSendOptions = {},
): Promise<{ sid: string | null }> {
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
    actualParts: parts.length,
  });

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  let lastSid: string | null = null;

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
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params,
          },
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
            retryable,
          });
        }

        const json = (await res.json()) as { sid?: string };
        lastSid = json.sid ?? null;
        break;
      } catch (error) {
        if (error instanceof TwilioSmsSendError) throw error;
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new TwilioSmsSendError(`twilio sms send failed: ${error instanceof Error ? error.message : String(error)}`, {
          retryable: true,
        });
      }
    }
  }

  return { sid: lastSid };
}
