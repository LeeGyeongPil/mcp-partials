// Example 2 — what happens when a transport drops the chunks.
//
//   npm run example:fallback
//
// The same streaming tool is served over Streamable HTTP on 127.0.0.1 (random port) twice:
//   sse  — the default: progress notifications travel on the SSE stream before the response
//   json — enableJsonResponse: true: the server answers with one JSON body, notifications are dropped
// The final result is identical either way; only the live preview is lost.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callToolStream, streamingTool, type FinalEvent } from 'mcp-partials';

const PARTS = 6;
const DELAY_MS = 20; // 일부러 늦춘 느린 도구

function makeServer(): McpServer {
  const server = new McpServer({ name: 'fallback-demo', version: '0.1.0' });
  server.registerTool(
    'count',
    { inputSchema: { n: z.number() } },
    streamingTool<{ n: number }>(async function* ({ n }) {
      for (let i = 0; i < n; i++) {
        await sleep(DELAY_MS);
        yield `part ${i}\n`;
      }
    }),
  );
  return server;
}

async function startHttp(jsonResponse: boolean): Promise<{ url: URL; close(): Promise<void> }> {
  // 무상태 서버: 요청마다 McpServer·전송을 새로 만들고, 응답이 닫히면 정리한다
  const httpServer = http.createServer(async (req, res) => {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: jsonResponse });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve)); // 로컬에만 연다
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function run(label: 'sse ' | 'json', jsonResponse: boolean): Promise<FinalEvent> {
  const http = await startHttp(jsonResponse);
  const client = new Client({ name: 'fallback-client', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(http.url));
  try {
    const t0 = performance.now();
    let firstChunkMs: number | undefined;
    for await (const ev of callToolStream(client, { name: 'count', arguments: { n: PARTS } })) {
      const at = Math.round(performance.now() - t0);
      if (ev.type === 'chunk') {
        firstChunkMs ??= at;
      } else {
        const first = firstChunkMs === undefined ? 'first chunk: none' : `first chunk +${firstChunkMs} ms`;
        console.log(
          `${label} chunks=${ev.chunks} streamed=${ev.streamed} missing=${JSON.stringify(ev.missing)}  ${first}, final +${at} ms`,
        );
        return ev;
      }
    }
    throw new Error('no final event');
  } finally {
    await client.close();
    await http.close();
  }
}

console.log(`Streamable HTTP on 127.0.0.1, tool sends ${PARTS} parts (artificially delayed ${DELAY_MS} ms each)`);
const sse = await run('sse ', false);
const json = await run('json', true);
console.log(`final identical: ${isDeepStrictEqual(sse.result, json.result)}`);
