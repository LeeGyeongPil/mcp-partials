// AC-2: SDK v2(@modelcontextprotocol/server·client 2.4.0)에서 AC-1 과 같은 도구 코드·같은 기대값.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  PARTIALS_FINAL_KEY,
  PartialsError,
  callToolStream,
  collectToolStream,
  detectClientSdk,
  partialsCapability,
  serverSupportsPartials,
  type ChunkEvent,
  type FinalEvent,
} from 'mcp-partials';
import { numberedLines, textOf, threeChunks, v2Harness } from './helpers.js';

test('v2: same tool code streams via ctx.mcpReq.notify', async () => {
  const h = await v2Harness((server) => {
    server.registerTool('three', { description: 'three chunks' }, threeChunks);
  });
  try {
    const events: Array<ChunkEvent | FinalEvent> = [];
    // sdk 옵션 없이 — v2 Client 인지 자동 판별
    for await (const ev of callToolStream(h.client, { name: 'three' })) events.push(ev);

    const chunks = events.filter((e): e is ChunkEvent => e.type === 'chunk');
    assert.deepEqual(
      chunks.map((c) => c.seq),
      [0, 1, 2],
    );
    assert.deepEqual(
      chunks.map((c) => textOf(c.content)),
      ['alpha ', 'beta ', 'gamma'],
    );
    const final = events.at(-1) as FinalEvent;
    assert.equal(events.length, 4);
    assert.equal(final.type, 'final');
    assert.equal(final.streamed, true);
    assert.equal(final.chunks, 3);
    assert.deepEqual(final.missing, []);
    assert.equal(final.duplicates, 0);
    assert.deepEqual(final.result.content, [{ type: 'text', text: 'alpha beta gamma' }]);
    assert.deepEqual(final.result._meta?.[PARTIALS_FINAL_KEY], { chunks: 3 });
  } finally {
    await h.close();
  }
});

test('v2: input schema tool, capability, detection', async () => {
  const h = await v2Harness(
    (server) => {
      server.registerTool('numbered', { inputSchema: z.object({ n: z.number() }) }, numberedLines('row'));
    },
    { capabilities: partialsCapability() },
  );
  try {
    assert.equal(detectClientSdk(h.client), 'v2');
    assert.equal(serverSupportsPartials(h.client), true);
    const collected = await collectToolStream(h.client, { name: 'numbered', arguments: { n: 6 } });
    assert.equal(collected.chunks, 6);
    assert.equal(collected.matchesFinal, true);
    assert.equal(textOf(collected.result.content), 'row 0\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5\n');
  } finally {
    await h.close();
  }
});

test('auto detection refuses an unknown client shape instead of guessing', async () => {
  const fake = { callTool: async () => ({ content: [] }) };
  await assert.rejects(
    callToolStream(fake, { name: 'x' }).result(),
    (error: unknown) => error instanceof PartialsError && error.code === 'UNSUPPORTED_SDK',
  );
  // sdk 를 명시하면 그 호출 규약으로 부른다
  const forced = await callToolStream(fake, { name: 'x' }, { sdk: 'v2' }).result();
  assert.equal(forced.streamed, false);
});
