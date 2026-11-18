// AC-1: SDK v1(@modelcontextprotocol/sdk 1.32.2) InMemory 에서 조각이 순서대로, 그리고 최종 결과.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  PARTIALS_FINAL_KEY,
  callToolStream,
  collectToolStream,
  detectClientSdk,
  partialsCapability,
  serverSupportsPartials,
  streamingTool,
  streamingToolMeta,
  type ChunkEvent,
  type FinalEvent,
} from 'mcp-partials';
import { numberedLines, textOf, threeChunks, v1Harness } from './helpers.js';

test('v1: streams chunks in order then authoritative final', async () => {
  const h = await v1Harness((server) => {
    server.registerTool('three', { description: 'three chunks' }, threeChunks);
  });
  try {
    const events: Array<ChunkEvent | FinalEvent> = [];
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
    assert.equal(final.type, 'final');
    assert.equal(events.length, 4, 'exactly three chunks then one final');
    assert.equal(final.streamed, true);
    assert.equal(final.chunks, 3);
    assert.deepEqual(final.missing, []);
    assert.equal(final.duplicates, 0);
    // 최종 content = 조각을 합친 텍스트(인접 text 블록 병합)
    assert.deepEqual(final.result.content, [{ type: 'text', text: 'alpha beta gamma' }]);
    assert.deepEqual(final.result._meta?.[PARTIALS_FINAL_KEY], { chunks: 3 });
  } finally {
    await h.close();
  }
});

test('v1: tool with an input schema, explicit return value, collectToolStream', async () => {
  const h = await v1Harness((server) => {
    server.registerTool(
      'lines',
      { inputSchema: { n: z.number() } },
      streamingTool<{ n: number }>(async function* ({ n }) {
        for (let i = 0; i < n; i++) yield `l${i};`;
        return { content: [{ type: 'text', text: `done ${n}` }], structuredContent: { n } };
      }),
    );
    server.registerTool('numbered', { inputSchema: { n: z.number() } }, numberedLines());
  });
  try {
    const collected = await collectToolStream(h.client, { name: 'lines', arguments: { n: 4 } });
    assert.equal(textOf(collected.content), 'l0;l1;l2;l3;');
    assert.deepEqual(collected.result.content, [{ type: 'text', text: 'done 4' }]);
    assert.deepEqual(collected.result.structuredContent, { n: 4 });
    assert.equal(collected.matchesFinal, false, 'explicit return differs from the chunks');

    const numbered = await collectToolStream(h.client, { name: 'numbered', arguments: { n: 5 } });
    assert.equal(numbered.chunks, 5);
    assert.equal(numbered.matchesFinal, true);
  } finally {
    await h.close();
  }
});

test('v1: generator error → isError final, chunks already sent are kept', async () => {
  const h = await v1Harness((server) => {
    server.registerTool(
      'fails',
      {},
      streamingTool(async function* () {
        yield 'partial output\n';
        throw new Error('disk full');
      }),
    );
    server.registerTool(
      'bad-yield',
      {},
      streamingTool(async function* () {
        yield 42 as unknown as string;
      }),
    );
  });
  try {
    const failed = await collectToolStream(h.client, { name: 'fails' });
    assert.equal(failed.chunks, 1);
    assert.equal(failed.result.isError, true);
    assert.match(textOf(failed.result.content), /disk full/);

    const bad = await collectToolStream(h.client, { name: 'bad-yield' });
    assert.equal(bad.result.isError, true);
    assert.match(textOf(bad.result.content), /chunk must be a string/);
  } finally {
    await h.close();
  }
});

test('v1: capability helpers and SDK detection', async () => {
  const h = await v1Harness(
    (server) => {
      server.registerTool('three', { description: 'three chunks', _meta: streamingToolMeta() }, threeChunks);
    },
    { capabilities: partialsCapability() },
  );
  try {
    assert.equal(detectClientSdk(h.client), 'v1');
    assert.equal(serverSupportsPartials(h.client), true);
    const tools = await h.client.listTools();
    assert.deepEqual(tools.tools[0]?._meta, streamingToolMeta());
  } finally {
    await h.close();
  }
});
