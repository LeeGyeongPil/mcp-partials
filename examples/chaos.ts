// Example 3 — an unreliable path: chunks duplicated, dropped and swapped on purpose.
//
//   npm run example:chaos              # seed 7
//   npm run example:chaos -- 42        # another seed
//
// Uses SDK v2 (@modelcontextprotocol/server + @modelcontextprotocol/client) over the in-memory transport.
// withChaos() really duplicates, drops and reorders the server's progress notifications (seeded, repeatable);
// callToolStream() still hands out ascending, unique chunks and reports what never arrived.
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { callToolStream, streamingTool, type FinalEvent } from 'mcp-partials';
import { withChaos, type ChaosStats } from 'mcp-partials/testing';

const seed = Number(process.argv[2] ?? 7);
const N = 20;

async function call(chaos: boolean): Promise<{ seqs: number[]; final: FinalEvent; stats?: ChaosStats }> {
  const server = new McpServer({ name: 'chaos-demo', version: '0.1.0' });
  server.registerTool(
    'numbers',
    { inputSchema: z.object({ n: z.number() }) },
    streamingTool<{ n: number }>(async function* ({ n }) {
      for (let i = 0; i < n; i++) {
        yield `n${i} `;
        await sleep(2);
      }
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // 서버가 내보내는 진행 알림을 30% 복제, 10% 누락, 30% 순서 바꿈
  const wrapped = chaos ? withChaos(serverTransport, { seed, duplicate: 0.3, drop: 0.1, reorder: 0.3 }) : undefined;
  await server.connect(wrapped ?? serverTransport);
  const client = new Client({ name: 'chaos-client', version: '0.1.0' });
  await client.connect(clientTransport);
  try {
    const seqs: number[] = [];
    for await (const ev of callToolStream(client, { name: 'numbers', arguments: { n: N } })) {
      if (ev.type === 'chunk') seqs.push(ev.seq);
      else return { seqs, final: ev, stats: wrapped?.stats() };
    }
    throw new Error('no final event');
  } finally {
    await client.close();
    await server.close();
  }
}

const clean = await call(false);
const noisy = await call(true);
const s = noisy.stats!;
console.log(`seed ${seed}: tool sent ${s.seen} chunks (testing transport, faults injected on purpose)`);
console.log(`injected  dropped=${JSON.stringify(s.dropped)} duplicated=${JSON.stringify(s.duplicated)} reordered=${JSON.stringify(s.reordered)}`);
console.log(`received  seq=${noisy.seqs.join(',')}`);
console.log(`final     missing=${JSON.stringify(noisy.final.missing)} duplicates=${noisy.final.duplicates} chunks=${noisy.final.chunks}`);
console.log(`final result identical to a clean call: ${isDeepStrictEqual(noisy.final.result, clean.final.result)}`);
