export type TwilioSmsConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

function normalizeSmsText(body: string): string {
  return body
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendTwilioSms(
  cfg: TwilioSmsConfig,
  to: string,
  body: string,
): Promise<{ sid: string | null }> {
  const accountSid = cfg.accountSid.trim();
  const authToken = cfg.authToken.trim();
  const fromNumber = cfg.fromNumber.trim();
  const normalizedBody = normalizeSmsText(body);

  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", fromNumber);
  params.set("Body", normalizedBody);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
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
  return { sid: json.sid ?? null };
}
