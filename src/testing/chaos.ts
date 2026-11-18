// 테스트용 전송 래퍼: 내보내는 진행 알림을 시드 고정 난수로 실제로 복제·누락·순서 바꿈 한다.
// 불안정한 경로(게이트웨이·재전송)에서 클라이언트가 조각을 제대로 조립하는지 재현하려는 용도.
import { metaCodec, type ChunkCodec } from '../codec.js';
import type { JsonRpcMessageLike, TransportLike } from '../types.js';

export interface ChaosOptions {
  /** PRNG seed — the same seed gives the same faults for the same message sequence. */
  seed: number;
  /** Probability (0..1) that a progress notification is sent twice. */
  duplicate?: number;
  /** Probability (0..1) that a progress notification is never sent. */
  drop?: number;
  /** Probability (0..1) that a progress notification is held back and sent after the next one. */
  reorder?: number;
  /** Which messages to disturb. Only `'progress'` (notifications/progress) is supported. */
  only?: 'progress';
  /** Codec used to read chunk seqs for `stats()`. Default `metaCodec`. */
  codec?: ChunkCodec;
}

export interface ChaosStats {
  /** Progress notifications that went into the wrapper. */
  seen: number;
  /** Chunk seqs that were dropped (ascending). */
  dropped: number[];
  /** Chunk seqs that were sent twice. */
  duplicated: number[];
  /** Chunk seqs that were held back and sent after the next notification. */
  reordered: number[];
}

/**
 * Wrap a transport (usually the server side) so its outgoing `notifications/progress` get
 * duplicated, dropped or swapped. Everything else passes through untouched, and a held-back
 * notification is always released before the next non-progress message (such as the tool
 * response), the way an SSE stream keeps notifications ahead of the response.
 */
export function withChaos<T extends TransportLike>(transport: T, opts: ChaosOptions): T & { stats(): ChaosStats } {
  const random = mulberry32(opts.seed);
  const codec = opts.codec ?? metaCodec;
  const stats: ChaosStats = { seen: 0, dropped: [], duplicated: [], reordered: [] };
  let held: Array<{ message: JsonRpcMessageLike; options: unknown }> = [];
  const send = transport.send.bind(transport);

  const releaseHeld = async (): Promise<void> => {
    const out = held;
    held = [];
    for (const h of out) await send(h.message, h.options);
  };

  const chaosSend = async (message: JsonRpcMessageLike, options?: unknown): Promise<void> => {
    if (message?.method !== 'notifications/progress') {
      await releaseHeld(); // 응답 등 다른 메시지보다 늦게 나가는 조각은 만들지 않는다
      return send(message, options);
    }
    stats.seen += 1;
    const seq = readSeq(codec, message.params);
    // 매 알림마다 난수를 같은 순서로 세 번 뽑는다 — 시드가 같으면 결과가 같다
    const rDrop = random();
    const rDup = random();
    const rReorder = random();
    if (rDrop < (opts.drop ?? 0)) {
      if (seq !== undefined) stats.dropped.push(seq);
      return;
    }
    const copies = rDup < (opts.duplicate ?? 0) ? 2 : 1;
    if (copies === 2 && seq !== undefined) stats.duplicated.push(seq);
    if (rReorder < (opts.reorder ?? 0) && held.length === 0) {
      // 이번 알림을 붙잡아 두었다가 다음 알림 뒤에 보낸다(인접한 두 알림의 순서 바꿈)
      for (let i = 0; i < copies; i++) held.push({ message, options });
      if (seq !== undefined) stats.reordered.push(seq);
      return;
    }
    for (let i = 0; i < copies; i++) await send(message, options);
    await releaseHeld();
  };

  const close = async (): Promise<void> => {
    held = []; // 닫을 때 붙잡은 알림은 버린다(타이머·버퍼를 남기지 않음)
    return transport.close();
  };

  return new Proxy(transport, {
    get(target, prop, receiver) {
      if (prop === 'send') return chaosSend;
      if (prop === 'close') return close;
      if (prop === 'stats') {
        return (): ChaosStats => ({
          seen: stats.seen,
          dropped: [...stats.dropped].sort((a, b) => a - b),
          duplicated: [...stats.duplicated],
          reordered: [...stats.reordered],
        });
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      // 메서드는 원래 객체에 묶어 private 필드(#x)를 쓰는 전송도 그대로 동작하게
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  }) as T & { stats(): ChaosStats };
}

function readSeq(codec: ChunkCodec, params: unknown): number | undefined {
  try {
    return codec.decode(params)?.seq;
  } catch {
    return undefined;
  }
}

/** Small seeded PRNG (mulberry32): deterministic numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
