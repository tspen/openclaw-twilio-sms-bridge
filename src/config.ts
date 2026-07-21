export type ResolvedAccount = {
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

export function resolveLegacyPluginSection(cfg: Record<string, any>): Record<string, any> {
  return ((cfg?.plugins?.entries?.["twilio-sms-bridge"]?.config ?? {}) as Record<string, any>);
}

export function resolveChannelSection(cfg: Record<string, any>): Record<string, any> {
  return ((cfg?.channels?.["twilio-sms-bridge"] ?? {}) as Record<string, any>);
}

export function resolveSection(cfg: Record<string, any>): Record<string, any> {
  const legacy = resolveLegacyPluginSection(cfg);
  const channel = resolveChannelSection(cfg);
  return { ...legacy, ...channel };
}

export function resolveAccount(cfg: Record<string, any>, accountId?: string | null): ResolvedAccount {
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
