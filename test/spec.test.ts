// AC-5: 스펙 준수 — 원문 전송 기록에서 progress 엄격 증가, 조각은 _meta 안에만, 응답 뒤 알림 0개, 최종 조각 수 일치.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  PARTIALS_FINAL_KEY,
  PARTIALS_META_KEY,
  callToolStream,
  streamingTool,
  type ContentBlock,
} from 'mcp-partials';
import { sleep, v1Harness, v2Harness, type WireEntry } from './helpers.js';

const SPEC_PROGRESS_FIELDS = new Set(['progressToken', 'progress', 'total', 'message', '_meta']);

// 섞인 모양의 조각: 문자열, 블록 하나, 블록 목록, 아주 긴 텍스트(기본 message 요약 확인)
const mixedTool = streamingTool<{ n: number }>(
  async function* ({ n }) {
    for (let i = 0; i < n; i++) {
      if (i % 3 === 0) yield `text ${i}\n`;
      else if (i % 3 === 1) yield { type: 'text', text: `block ${i}\n` };
      else yield [{ type: 'text', text: `list ${i}\n` }, { type: 'image', data: 'AAAA', mimeType: 'image/png' } as ContentBlock];
      await sleep(1);
    }
    yield 'x'.repeat(500);
  },
  { total: 99 },
);

function checkWire(wire: WireEntry[]): void {
  const response = wire.find((w) => w.message?.result?._meta?.[PARTIALS_FINAL_KEY] !== undefined);
  assert.ok(response, 'tool response recorded');
  const progress = wire.filter((w) => w.message?.method === 'notifications/progress');
  assert.ok(progress.length > 0);
  const token = progress[0]!.message.params.progressToken;

  let last = 0;
  progress.forEach((w, i) => {
    const params = w.message.params;
    assert.equal(params.progressToken, token);
    // progress 는 매번 엄격 증가(MUST)
    assert.ok(params.progress > last, `progress ${params.progress} after ${last}`);
    last = params.progress;
    // 최상위에는 스펙 필드만 — 조각 데이터는 _meta 안에만
    for (const key of Object.keys(params)) assert.ok(SPEC_PROGRESS_FIELDS.has(key), `unexpected top-level field ${key}`);
    assert.deepEqual(Object.keys(params._meta), [PARTIALS_META_KEY]);
    assert.equal(params._meta[PARTIALS_META_KEY].seq, i);
    assert.ok(Array.isArray(params._meta[PARTIALS_META_KEY].content));
    assert.equal(params.total, 99);
    assert.ok(typeof params.message === 'string' && params.message.length <= 200);
    // 응답보다 먼저 나갔다
    assert.ok(w.order < response.order, 'progress notification sent before the response');
  });
  // 응답 이후 그 토큰의 알림 0개
  const after = wire.filter((w) => w.order > response.order && w.message?.params?.progressToken === token);
  assert.equal(after.length, 0);
  // 최종 결과의 조각 수 = 보낸 조각 수
  assert.deepEqual(response.message.result._meta[PARTIALS_FINAL_KEY], { chunks: progress.length });
}

test('progress strictly increasing, chunk only in _meta, nothing after response', async () => {
  const h1 = await v1Harness((server) => server.registerTool('mixed', { inputSchema: { n: z.number() } }, mixedTool));
  try {
    const stream = callToolStream(h1.client, { name: 'mixed', arguments: { n: 7 } });
    let chunks = 0;
    for await (const ev of stream) if (ev.type === 'chunk') chunks += 1;
    await sleep(30); // 늦게 오는 알림이 있는지 잠시 더 기다린다
    checkWire(h1.wire);
    assert.equal(chunks, 8);
    const final = await stream.result();
    // 이미지 블록은 그대로, 인접 text 는 병합
    assert.ok(final.result.content.some((b: ContentBlock) => b.type === 'image'));
  } finally {
    await h1.close();
  }

  const h2 = await v2Harness((server) => server.registerTool('mixed', { inputSchema: z.object({ n: z.number() }) }, mixedTool));
  try {
    for await (const ev of callToolStream(h2.client, { name: 'mixed', arguments: { n: 5 } })) void ev;
    await sleep(30);
    checkWire(h2.wire);
  } finally {
    await h2.close();
  }
});
