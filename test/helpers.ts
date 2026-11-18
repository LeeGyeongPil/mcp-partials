// 테스트 공용: 실제 공식 SDK(v1·v2) 서버·클라이언트를 InMemory 전송으로 잇고, 서버가 내보내는 원문을 기록한다.
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport as InMemoryV1 } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as McpServerV2, InMemoryTransport as InMemoryV2 } from '@modelcontextprotocol/server';
import { Client as ClientV2 } from '@modelcontextprotocol/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { streamingTool, type TransportLike } from 'mcp-partials';

export { sleep };

/** One message the server transport sent, with a global order number. */
export interface WireEntry {
  order: number;
  message: any;
}

export interface Harness<S, C> {
  server: S;
  client: C;
  wire: WireEntry[];
  events: string[]; // 테스트가 순서를 따질 때 쓰는 공용 기록(원문 전송·서버 생성기 사건)
  close(): Promise<void>;
}

/** Record everything the server sends, then optionally wrap the transport (e.g. withChaos). */
function recordSends<T extends TransportLike>(transport: T, wire: WireEntry[], events: string[]): void {
  const send = transport.send.bind(transport);
  let order = 0;
  transport.send = async (message: any, options?: any) => {
    wire.push({ order: order++, message });
    if (message?.method === 'notifications/progress') events.push(`progress:${message.params.progressToken}`);
    else if (message?.id !== undefined && ('result' in message || 'error' in message)) events.push(`response:${message.id}`);
    return send(message, options);
  };
}

export interface HarnessOptions {
  wrapServerTransport?: <T extends TransportLike>(t: T) => T;
  capabilities?: Record<string, unknown>;
}

export async function v1Harness(
  register: (server: McpServerV1, events: string[]) => void,
  opts: HarnessOptions = {},
): Promise<Harness<McpServerV1, ClientV1>> {
  const wire: WireEntry[] = [];
  const events: string[] = [];
  const server = new McpServerV1({ name: 'test-v1', version: '0.0.0' }, { capabilities: opts.capabilities ?? {} });
  register(server, events);
  const [clientTransport, serverTransport] = InMemoryV1.createLinkedPair();
  recordSends(serverTransport, wire, events);
  await server.connect(opts.wrapServerTransport ? opts.wrapServerTransport(serverTransport) : serverTransport);
  const client = new ClientV1({ name: 'test-client-v1', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    server,
    client,
    wire,
    events,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function v2Harness(
  register: (server: McpServerV2, events: string[]) => void,
  opts: HarnessOptions = {},
): Promise<Harness<McpServerV2, ClientV2>> {
  const wire: WireEntry[] = [];
  const events: string[] = [];
  const server = new McpServerV2({ name: 'test-v2', version: '0.0.0' }, { capabilities: opts.capabilities ?? {} });
  register(server, events);
  const [clientTransport, serverTransport] = InMemoryV2.createLinkedPair();
  recordSends(serverTransport, wire, events);
  await server.connect(opts.wrapServerTransport ? opts.wrapServerTransport(serverTransport) : serverTransport);
  const client = new ClientV2({ name: 'test-client-v2', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    server,
    client,
    wire,
    events,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The tool body shared by the v1 and v2 tests: three chunks, no explicit return. */
export const threeChunks = streamingTool(async function* () {
  yield 'alpha ';
  await sleep(2);
  yield 'beta ';
  await sleep(2);
  yield 'gamma';
});

/** A tool that yields `n` numbered lines with a small delay. */
export function numberedLines(prefix = 'line') {
  return streamingTool<{ n: number }>(async function* ({ n }) {
    for (let i = 0; i < n; i++) {
      yield `${prefix} ${i}\n`;
      await sleep(1);
    }
  });
}

export function progressMessages(wire: WireEntry[]): any[] {
  return wire.filter((w) => w.message?.method === 'notifications/progress').map((w) => w.message);
}

export function textOf(content: Array<{ type: string; text?: unknown }>): string {
  return content.map((b) => (b.type === 'text' ? String(b.text) : '')).join('');
}
