export type InboundSmsMessage = {
  from: string;
  to: string;
  body: string;
  messageSid: string | null;
};

export type OutboundSmsStatus = {
  sid: string;
  to?: string;
  from?: string;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  updatedAt: number;
};

const recentInbound = new Map<string, InboundSmsMessage>();
const processedInbound = new Map<string, number>();
const outboundStatuses = new Map<string, OutboundSmsStatus>();

const TRACKED_ITEM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_ITEMS = 200;

function pruneMapByAge<T>(map: Map<string, T>, readTimestamp: (item: T) => number, now = Date.now()): void {
  for (const [key, item] of map) {
    if (now - readTimestamp(item) > TRACKED_ITEM_TTL_MS) map.delete(key);
  }
  while (map.size > MAX_TRACKED_ITEMS) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}

export function rememberInboundSms(msg: InboundSmsMessage): void {
  const key = msg.messageSid ?? `${msg.from}:${Date.now()}`;
  recentInbound.set(key, msg);
  while (recentInbound.size > MAX_TRACKED_ITEMS) {
    const oldestKey = recentInbound.keys().next().value;
    if (!oldestKey) break;
    recentInbound.delete(oldestKey);
  }
}

export function listRecentInboundSms(): InboundSmsMessage[] {
  return Array.from(recentInbound.values()).slice(-20);
}

export function markInboundSmsSeen(messageSid: string | null | undefined, now = Date.now()): boolean {
  if (!messageSid) return false;
  pruneMapByAge(processedInbound, (timestamp) => timestamp, now);
  if (processedInbound.has(messageSid)) return true;
  processedInbound.set(messageSid, now);
  return false;
}

export function rememberOutboundSmsStatus(status: OutboundSmsStatus): void {
  outboundStatuses.set(status.sid, status);
  pruneMapByAge(outboundStatuses, (item) => item.updatedAt, status.updatedAt);
}

export function listRecentOutboundSmsStatuses(): OutboundSmsStatus[] {
  return Array.from(outboundStatuses.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
}

export function resetTwilioSmsStateForTests(): void {
  recentInbound.clear();
  processedInbound.clear();
  outboundStatuses.clear();
}
