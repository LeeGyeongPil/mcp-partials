// AC-8: coalesceMs 로 아주 작은 조각을 묶어 보내도 내용은 같다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectToolStream, streamingTool } from 'mcp-partials';
import { progressMessages, sleep, textOf, v1Harness } from './helpers.js';

// 약 10ms 동안 100번 yield 하는 도구(10번마다 1ms 쉼)
function burst(coalesceMs: number) {
  return streamingTool(
    async function* () {
      for (let i = 0; i < 100; i++) {
        yield `t${i} `;
        if (i % 10 === 9) await sleep(1);
      }
    },
    { coalesceMs },
  );
}

test('coalesceMs batches tiny chunks without changing content', async () => {
  const h = await v1Harness((server) => {
    server.registerTool('burst0', {}, burst(0));
    server.registerTool('burst50', {}, burst(50));
  });
  try {
    const plain = await collectToolStream(h.client, { name: 'burst0' });
    const plainNotifications = progressMessages(h.wire).length;
    h.wire.length = 0;
    const batched = await collectToolStream(h.client, { name: 'burst50' });
    const batchedNotifications = progressMessages(h.wire).length;

    assert.equal(plainNotifications, 100);
    assert.ok(batchedNotifications >= 1 && batchedNotifications <= 10, `${batchedNotifications} notifications`);
    assert.equal(batched.chunks, batchedNotifications);
    // 합친 조각 텍스트와 최종 결과 content 는 묶든 안 묶든 같다
    const expected = Array.from({ length: 100 }, (_, i) => `t${i} `).join('');
    assert.equal(textOf(plain.content), expected);
    assert.equal(textOf(batched.content), expected);
    assert.deepEqual(batched.result.content, plain.result.content);
    assert.equal(batched.matchesFinal, true);
    assert.deepEqual(batched.missing, []);
  } finally {
    await h.close();
  }
});

test('a slow tool with coalesceMs still sends each window without waiting for the end', async () => {
  const h = await v1Harness((server) => {
    server.registerTool(
      'slow',
      {},
      streamingTool(
        async function* () {
          for (let i = 0; i < 4; i++) {
            yield `s${i} `;
            await sleep(60); // 창(10ms)보다 훨씬 긴 간격 → 조각마다 따로 나간다
          }
        },
        { coalesceMs: 10 },
      ),
    );
  });
  try {
    const collected = await collectToolStream(h.client, { name: 'slow' });
    assert.equal(collected.chunks, 4);
    assert.equal(textOf(collected.content), 's0 s1 s2 s3 ');
  } finally {
    await h.close();
  }
});
