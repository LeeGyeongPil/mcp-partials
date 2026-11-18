// 기능 알림 도우미: 서버가 "나는 조각을 보낸다"를 initialize 응답·도구 목록에 표시하고,
// 클라이언트가 그 표시를 읽는다. 표시가 없어도 동작은 같다(최종 결과만 받을 뿐).
import { PARTIALS_CAPABILITY_KEY, isRecord } from './codec.js';

/** Protocol version of the chunk format this library speaks. */
export const PARTIALS_VERSION = 1;

/**
 * Server capabilities to merge into `new McpServer(info, { capabilities: { ...partialsCapability() } })`.
 * Adds `experimental["io.github.mcp-partials"] = { version: 1 }`.
 */
export function partialsCapability(): { experimental: Record<string, { version: number }> } {
  return { experimental: { [PARTIALS_CAPABILITY_KEY]: { version: PARTIALS_VERSION } } };
}

/** Tool `_meta` marking a tool as streaming: pass as `_meta` in the tool config. */
export function streamingToolMeta(): Record<string, { version: number }> {
  return { [`${PARTIALS_CAPABILITY_KEY}/streaming`]: { version: PARTIALS_VERSION } };
}

/** True when the connected server advertised `partialsCapability()`. Call after `client.connect()`. */
export function serverSupportsPartials(client: unknown): boolean {
  if (!isRecord(client) || typeof client['getServerCapabilities'] !== 'function') return false;
  const caps: unknown = (client['getServerCapabilities'] as () => unknown).call(client);
  if (!isRecord(caps) || !isRecord(caps['experimental'])) return false;
  return isRecord(caps['experimental'][PARTIALS_CAPABILITY_KEY]);
}
