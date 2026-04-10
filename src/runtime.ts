import { getTwilioSmsRuntime } from "./runtime-store.js";

export type InboundSmsMessage = {
  from: string;
  to: string;
  body: string;
  messageSid: string | null;
};

export type TwilioSmsRuntimeContext = {
  cfg: any;
  accountId?: string | null;
  core: any;
  runtimeStoreName?: string;
};

const recentInbound = new Map<string, InboundSmsMessage>();

export function rememberInboundSms(msg: InboundSmsMessage): void {
  const key = msg.messageSid ?? `${msg.from}:${Date.now()}`;
  recentInbound.set(key, msg);
}

export function listRecentInboundSms(): InboundSmsMessage[] {
  return Array.from(recentInbound.values()).slice(-20);
}

export function getTwilioSmsRuntimeContext(accountId?: string | null): TwilioSmsRuntimeContext | undefined {
  const runtime = getTwilioSmsRuntime() as any;
  if (!runtime?.channel || !runtime?.config) return undefined;
  const loadedCfg = typeof runtime.config.loadConfig === "function" ? runtime.config.loadConfig() : runtime.config;
  return {
    cfg: loadedCfg,
    accountId: accountId ?? null,
    core: runtime,
    runtimeStoreName: loadedCfg?.session?.store,
  };
}
