// AC-3: 하위 호환 폴백 — 토큰 없는 호출, JSON 응답 모드(조각이 사라지는 전송), SSE 모드(조각이 먼저 도착).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callToolStream, streamingTool, type FinalEvent } from 'mcp-partials';
import { numberedLines, progressMessages, sleep, textOf, v1Harness, v2Harness } from './helpers.js';

test('no token → final only', async () => {
  // v1: onprogress 없이 부르면 SDK 가 progressToken 을 붙이지 않는다 → 서버는 조각을 보내지 않는다
  const h1 = await v1Harness((server) => server.registerTool('numbered', { inputSchema: { n: z.number() } }, numberedLines()));
  try {
    const result = await h1.client.callTool({ name: 'numbered', arguments: { n: 4 } });
    assert.equal(progressMessages(h1.wire).length, 0, 'no progress notifications without a token');
    assert.deepEqual(result.content, [{ type: 'text', text: 'line 0\nline 1\nline 2\nline 3\n' }]);
  } finally {
    await h1.close();
  }
  // v2 도 같다
  const h2 = await v2Harness((server) =>
    server.registerTool('numbered', { inputSchema: z.object({ n: z.number() }) }, numberedLines()),
  );
  try {
    const result = await h2.client.callTool({ name: 'numbered', arguments: { n: 3 } });
    assert.equal(progressMessages(h2.wire).length, 0);
    assert.deepEqual(result.content, [{ type: 'text', text: 'line 0\nline 1\nline 2\n' }]);
  } finally {
    await h2.close();
  }
});

// 127.0.0.1 임의 포트의 Streamable HTTP 서버(무상태: 요청마다 서버·전송을 새로 만든다)
async function startHttp(jsonResponse: boolean): Promise<{ url: URL; close(): Promise<void> }> {
  const httpServer = http.createServer(async (req, res) => {
    const server = new McpServer({ name: 'http-test', version: '0.0.0' });
    server.registerTool(
      'slow',
      { inputSchema: { n: z.number() } },
      streamingTool<{ n: number }>(async function* ({ n }) {
        for (let i = 0; i < n; i++) {
          yield `part ${i}\n`;
          await sleep(25); // 일부러 늦춘 느린 도구
        }
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: jsonResponse });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
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

async function callOverHttp(jsonResponse: boolean) {
  const srv = await startHttp(jsonResponse);
  const client = new Client({ name: 'http-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  try {
    const t0 = Date.now();
    const chunkTimes: number[] = [];
    let finalAt = -1;
    let final: FinalEvent | undefined;
    for await (const ev of callToolStream(client, { name: 'slow', arguments: { n: 4 } })) {
      if (ev.type === 'chunk') chunkTimes.push(Date.now() - t0);
      else {
        finalAt = Date.now() - t0;
        final = ev;
      }
    }
    return { chunkTimes, finalAt, final: final! };
  } finally {
    await client.close();
    await srv.close();
  }
}

test('json response mode → streamed:false, same final', async () => {
  const sse = await callOverHttp(false);
  const json = await callOverHttp(true);
  assert.equal(json.chunkTimes.length, 0, 'JSON response mode drops progress notifications');
  assert.equal(json.final.streamed, false);
  assert.equal(json.final.chunks, 0);
  // 서버는 4조각을 보냈다고 알리므로, 받지 못한 seq 가 전부 missing 으로 보고된다
  assert.deepEqual(json.final.missing, [0, 1, 2, 3]);
  // 최종 결과는 SSE 모드와 똑같다 — 최종 결과가 권위
  assert.deepEqual(json.final.result, sse.final.result);
  assert.equal(textOf(json.final.result.content), 'part 0\npart 1\npart 2\npart 3\n');
});

test('sse mode → chunks before final', async () => {
  const sse = await callOverHttp(false);
  assert.equal(sse.chunkTimes.length, 4);
  assert.equal(sse.final.streamed, true);
  assert.deepEqual(sse.final.missing, []);
  for (const t of sse.chunkTimes) assert.ok(t <= sse.finalAt, 'every chunk arrives before the final');
  // 첫 조각은 도구가 끝나기(약 100ms) 훨씬 전에 도착한다 — 진짜 점진 전달
  assert.ok(sse.finalAt - sse.chunkTimes[0]! >= 50, `first chunk at ${sse.chunkTimes[0]}ms, final at ${sse.finalAt}ms`);
});
