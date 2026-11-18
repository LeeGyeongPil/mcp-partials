// AC-4: 시드 고정 chaos(중복·누락·순서 바꿈) 경로에서도 조각은 오름차순·중복 없음, 누락은 정확히 보고, 최종 결과는 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { callToolStream, type ChunkEvent, type FinalEvent, type TransportLike } from 'mcp-partials';
import { withChaos, mulberry32, type ChaosStats } from 'mcp-partials/testing';
import { numberedLines, v1Harness, v2Harness } from './helpers.js';

type Sdk = 'v1' | 'v2';
interface Case {
  sdk: Sdk;
  seed: number;
  drop: number;
  tail: boolean; // must the last seq (19) be dropped?
}

async function run(sdk: Sdk, chaos: { seed: number; drop: number } | null) {
  let stats: (() => ChaosStats) | undefined;
  const wrap = <T extends TransportLike>(t: T): T => {
    if (!chaos) return t;
    const wrapped = withChaos(t, { seed: chaos.seed, duplicate: 0.3, drop: chaos.drop, reorder: 0.3, only: 'progress' });
    stats = () => wrapped.stats();
    return wrapped;
  };
  const h =
    sdk === 'v1'
      ? await v1Harness((server) => server.registerTool('numbered', { inputSchema: { n: z.number() } }, numberedLines()), {
          wrapServerTransport: wrap,
        })
      : await v2Harness((server) => server.registerTool('numbered', { inputSchema: z.object({ n: z.number() }) }, numberedLines()), {
          wrapServerTransport: wrap,
        });
  try {
    const chunks: ChunkEvent[] = [];
    let final: FinalEvent | undefined;
    for await (const ev of callToolStream(h.client as never, { name: 'numbered', arguments: { n: 20 } })) {
      if (ev.type === 'chunk') chunks.push(ev);
      else final = ev;
    }
    return { chunks, final: final!, stats: stats?.() };
  } finally {
    await h.close();
  }
}

// seed 7 / drop 0.1: head drop only. seed 38 / drop 0.3: drops [13,14,19] -> the tail seq is lost (measured by QA).
const cases: Case[] = [
  { sdk: 'v1', seed: 7, drop: 0.1, tail: false },
  { sdk: 'v2', seed: 7, drop: 0.1, tail: false },
  { sdk: 'v1', seed: 38, drop: 0.3, tail: true },
  { sdk: 'v2', seed: 38, drop: 0.3, tail: true },
];

for (const c of cases) {
  test(`seeded chaos (${c.sdk}, seed ${c.seed}, drop ${c.drop}): ascending unique chunks, exact missing, final unchanged`, async () => {
    const clean = await run(c.sdk, null);
    const noisy = await run(c.sdk, { seed: c.seed, drop: c.drop });
    const stats = noisy.stats!;

    // chaos must really have happened
    assert.equal(stats.seen, 20);
    assert.ok(stats.dropped.length > 0, 'some chunks dropped');
    assert.ok(stats.duplicated.length > 0, 'some chunks duplicated');
    assert.ok(stats.reordered.length > 0, 'some chunks reordered');
    if (c.tail) assert.ok(stats.dropped.includes(19), `tail seq 19 dropped, got ${JSON.stringify(stats.dropped)}`);

    // received chunks: strictly ascending, no duplicates
    const seqs = noisy.chunks.map((x) => x.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, `seq ${seqs[i]} after ${seqs[i - 1]}`);
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(seqs.length, 20 - stats.dropped.length);

    // missing == what chaos dropped (including the tail when it was dropped)
    assert.deepEqual(noisy.final.missing, stats.dropped);
    assert.equal(noisy.final.duplicates, stats.duplicated.length);
    assert.deepEqual(
      [...seqs, ...noisy.final.missing].sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => i),
    );

    // final result equals the chaos-free call
    assert.deepEqual(noisy.final.result, clean.final.result);
    assert.equal(clean.final.chunks, 20);
    assert.deepEqual(clean.final.missing, []);
  });
}

test('chaos is deterministic for a seed', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const c = mulberry32(8);
  const seqA = Array.from({ length: 5 }, () => a());
  assert.deepEqual(
    seqA,
    Array.from({ length: 5 }, () => b()),
  );
  assert.notDeepEqual(
    seqA,
    Array.from({ length: 5 }, () => c()),
  );
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
});
