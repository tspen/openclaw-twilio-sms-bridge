import { getTwilioSmsRuntime } from "./runtime-store.js";
export {
  listRecentInboundSms,
  listRecentOutboundSmsStatuses,
  markInboundSmsSeen,
  rememberInboundSms,
  rememberOutboundSmsStatus,
} from "./state.js";
export type { InboundSmsMessage, OutboundSmsStatus } from "./state.js";

export type TwilioSmsRuntimeContext = {
  cfg: any;
  accountId?: string | null;
  core: any;
  runtimeStoreName?: string;
};

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
