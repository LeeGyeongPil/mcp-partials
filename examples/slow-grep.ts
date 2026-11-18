// Example 1 — a slow "grep" tool whose matches show up while it is still running.
//
//   npm run example                 # chunks with arrival time, then the final result
//   npm run example -- --wire       # also print the raw notifications/progress JSON
//   npm run example -- ERROR WARN   # choose the words to search for
//
// Everything runs in one process over the SDK's in-memory transport: no network, no API key.
// The tool is artificially slowed down (a short sleep per log line) so you can watch chunks arrive.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callToolStream, partialsCapability, streamingTool } from 'mcp-partials';

const argv = process.argv.slice(2);
const showWire = argv.includes('--wire');
const words = argv.filter((a) => !a.startsWith('--'));
const pattern = words.length > 0 ? words : ['ERROR'];
const lines = readFileSync(new URL('../../examples/data/app.log', import.meta.url), 'utf8').trimEnd().split('\n');
const DELAY_MS = 15; // 일부러 늦춘다 — 줄 하나 검사에 15ms 가 걸리는 "느린 도구"

// ── server: an ordinary McpServer, the tool body is an async generator ──
const server = new McpServer({ name: 'slow-grep', version: '0.1.0' }, { capabilities: partialsCapability() });
server.registerTool(
  'slow_grep',
  {
    description: 'Search the sample log line by line and stream every match as it is found',
    inputSchema: { words: z.array(z.string()) },
  },
  streamingTool<{ words: string[] }>(async function* ({ words }, ctx) {
    for (const [i, line] of lines.entries()) {
      await sleep(DELAY_MS, undefined, { signal: ctx.signal }); // 취소되면 바로 멈춘다
      if (words.some((w) => line.includes(w))) yield `${i + 1}: ${line}\n`; // 찾는 즉시 조각으로
    }
    // return 이 없으면 yield 한 줄을 모두 합친 것이 최종 결과가 된다
  }),
);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
if (showWire) {
  // 서버가 실제로 내보내는 JSON-RPC 알림을 그대로 찍는다
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ('method' in message && message.method === 'notifications/progress') console.log(`wire      ${JSON.stringify(message)}`);
    return send(message, options);
  };
}
await server.connect(serverTransport);

// ── client: the official Client, read chunks with for await ──
const client = new Client({ name: 'example-client', version: '0.1.0' });
await client.connect(clientTransport);

console.log(`slow_grep ${JSON.stringify(pattern)} over ${lines.length} log lines (tool artificially delayed ${DELAY_MS} ms per line)`);
const t0 = performance.now();
const ms = (): string => `+${String(Math.round(performance.now() - t0)).padStart(4)} ms`;

for await (const ev of callToolStream(client, { name: 'slow_grep', arguments: { words: pattern } })) {
  if (ev.type === 'chunk') {
    const text = ev.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
    console.log(`chunk #${ev.seq}  ${ms()}  ${text.trimEnd()}`);
  } else {
    const finalText = ev.result.content.map((b: { type: string; text?: string }) => b.text ?? '').join('');
    console.log(
      `final     ${ms()}  streamed=${ev.streamed} chunks=${ev.chunks} missing=${JSON.stringify(ev.missing)} duplicates=${ev.duplicates}` +
        ` (final result: ${finalText.split('\n').filter(Boolean).length} lines)`,
    );
  }
}

await client.close();
await server.close();
