// AC-7: 취소 — break 또는 signal.abort() 하면 요청이 취소되고 서버 생성기의 finally 가 1초 안에 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PartialsError, callToolStream, streamingTool } from 'mcp-partials';
import { sleep, v1Harness, v2Harness } from './helpers.js';

interface Probe {
  finallyAt: number | undefined;
}

// 거의 끝나지 않는 도구: 10ms 마다 한 줄, finally 에서 정리 시각을 남긴다
function registerTicks(server: { registerTool: Function }, events: string[], probe: Probe): void {
  server.registerTool(
    'ticks',
    {},
    streamingTool(async function* (_args, ctx) {
      ctx.signal.addEventListener('abort', () => events.push('server-abort'));
      try {
        for (let i = 0; i < 1000; i++) {
          yield `tick ${i}\n`;
          await sleep(10);
        }
      } finally {
        events.push('generator-finally');
        probe.finallyAt = Date.now();
      }
    }),
  );
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(5);
  }
  return check();
}

function progressAfter(events: string[], marker: string): string[] {
  const at = events.indexOf(marker);
  assert.ok(at >= 0, `${marker} recorded`);
  return events.slice(at + 1).filter((e) => e.startsWith('progress:'));
}

// 같은 시나리오를 SDK v1·v2 양쪽에서 돌린다
type MakeHarness = (
  register: (server: { registerTool: Function }, events: string[]) => void,
) => Promise<{ client: unknown; events: string[]; close(): Promise<void> }>;
const HARNESSES: Array<[string, MakeHarness]> = [
  ['v1', v1Harness],
  ['v2', v2Harness],
];

test('break cancels request and runs generator finally', async (t) => {
  for (const [label, makeHarness] of HARNESSES) await t.test(label, () => breakCase(makeHarness));
});

test('abort signal rejects with ABORTED', async (t) => {
  for (const [label, makeHarness] of HARNESSES) await t.test(label, () => abortCase(makeHarness));
});

async function breakCase(makeHarness: MakeHarness): Promise<void> {
  const probe: Probe = { finallyAt: undefined };
  const h = await makeHarness((server, events) => registerTicks(server, events, probe));
  try {
    let seen = 0;
    let brokeAt = 0;
    for await (const ev of callToolStream(h.client, { name: 'ticks' })) {
      if (ev.type === 'chunk') seen += 1;
      if (seen === 3) {
        brokeAt = Date.now();
        break; // 세 번째 조각 뒤 그만 받기
      }
    }
    assert.equal(seen, 3);
    assert.ok(await waitFor(() => probe.finallyAt !== undefined, 1000), 'generator finally ran');
    assert.ok(probe.finallyAt! - brokeAt < 1000, `finally after ${probe.finallyAt! - brokeAt}ms`);
    await sleep(60); // 늦은 알림이 있는지 잠시 더 본다
    assert.ok(h.events.includes('server-abort'), 'server saw notifications/cancelled');
    assert.deepEqual(progressAfter(h.events, 'server-abort'), [], 'no progress after cancellation');
    // SDK 는 요청 id 를 progressToken 으로 쓴다 — 취소된 요청에는 응답이 나가지 않는다
    const token = h.events.find((e) => e.startsWith('progress:'))!.slice('progress:'.length);
    assert.ok(!h.events.includes(`response:${token}`), 'no response for the cancelled request');
  } finally {
    await h.close();
  }
}

async function abortCase(makeHarness: MakeHarness): Promise<void> {
  const probe: Probe = { finallyAt: undefined };
  const h = await makeHarness((server, events) => registerTicks(server, events, probe));
  try {
    const controller = new AbortController();
    const stream = callToolStream(h.client, { name: 'ticks' }, { signal: controller.signal });
    let seen = 0;
    let abortedAt = 0;
    await assert.rejects(
      (async () => {
        for await (const ev of stream) {
          if (ev.type === 'chunk') seen += 1;
          if (seen === 3 && abortedAt === 0) {
            abortedAt = Date.now();
            controller.abort(); // 세 번째 조각 뒤 취소
          }
        }
      })(),
      (error: unknown) => error instanceof PartialsError && error.code === 'ABORTED',
    );
    await assert.rejects(stream.result(), (error: unknown) => error instanceof PartialsError && error.code === 'ABORTED');
    assert.ok(await waitFor(() => probe.finallyAt !== undefined, 1000), 'generator finally ran');
    assert.ok(probe.finallyAt! - abortedAt < 1000, `finally after ${probe.finallyAt! - abortedAt}ms`);
    await sleep(60);
    assert.deepEqual(progressAfter(h.events, 'server-abort'), [], 'no progress after cancellation');
  } finally {
    await h.close();
  }
}

test('an already-aborted signal never starts the call', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const fake = {
    callTool: async () => {
      called = true;
      return { content: [] };
    },
  };
  await assert.rejects(
    callToolStream(fake, { name: 'x' }, { signal: controller.signal, sdk: 'v2' }).result(),
    (error: unknown) => error instanceof PartialsError && error.code === 'ABORTED',
  );
  assert.equal(called, false);
});
