// AC-6: 같은 도구를 다른 인자로 동시에 두 번 — 각 스트림은 자기 조각만 받는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { collectToolStream, streamingTool } from 'mcp-partials';
import { progressMessages, sleep, textOf, v1Harness, v2Harness } from './helpers.js';

const tagged = streamingTool<{ tag: string; n: number }>(async function* ({ tag, n }) {
  for (let i = 0; i < n; i++) {
    yield `${tag}-${i};`;
    await sleep(3); // 두 호출의 조각이 전송선 위에서 섞이도록
  }
});

async function check(client: unknown, wire: Parameters<typeof progressMessages>[0]): Promise<void> {
  const [a, b] = await Promise.all([
    collectToolStream(client, { name: 'tagged', arguments: { tag: 'A', n: 10 } }),
    collectToolStream(client, { name: 'tagged', arguments: { tag: 'B', n: 10 } }),
  ]);
  const expectA = Array.from({ length: 10 }, (_, i) => `A-${i};`).join('');
  const expectB = Array.from({ length: 10 }, (_, i) => `B-${i};`).join('');
  assert.equal(textOf(a.content), expectA, 'stream A only has A chunks');
  assert.equal(textOf(b.content), expectB, 'stream B only has B chunks');
  assert.equal(a.chunks, 10);
  assert.equal(b.chunks, 10);
  assert.equal(a.matchesFinal, true);
  assert.equal(b.matchesFinal, true);
  // 정말 동시에 돌았는지: 전송 기록에서 두 토큰의 알림이 번갈아 나타난다
  const tokens = progressMessages(wire).map((m) => m.params.progressToken);
  const switches = tokens.filter((t, i) => i > 0 && t !== tokens[i - 1]).length;
  assert.ok(switches >= 2, `notifications interleaved (${switches} switches)`);
}

test('two concurrent calls do not mix chunks', async () => {
  const h1 = await v1Harness((server) =>
    server.registerTool('tagged', { inputSchema: { tag: z.string(), n: z.number() } }, tagged),
  );
  try {
    await check(h1.client, h1.wire);
  } finally {
    await h1.close();
  }
  const h2 = await v2Harness((server) =>
    server.registerTool('tagged', { inputSchema: z.object({ tag: z.string(), n: z.number() }) }, tagged),
  );
  try {
    await check(h2.client, h2.wire);
  } finally {
    await h2.close();
  }
});
