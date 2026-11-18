// 받은 조각을 seq 순서로 다시 세우고(재정렬), 같은 seq 를 두 번 내보내지 않고(중복 제거),
// 끝까지 안 온 seq 를 기록한다(누락). 전송·SDK 와 무관한 순수 로직이다.
import type { ContentBlock } from './types.js';

/** A seq this far ahead of the next expected one is treated as garbage (keeps memory bounded). */
export const MAX_SEQ_JUMP = 100_000;

/** One in-order chunk handed to the caller. */
export interface ChunkEvent {
  type: 'chunk';
  seq: number;
  content: ContentBlock[];
}

export interface ChunkAssemblerOptions {
  /** How many out-of-order chunks to hold while waiting for a gap to fill. Default 16. */
  window?: number;
}

export class ChunkAssembler {
  private next = 0; // 다음에 내보낼 seq
  private readonly pending = new Map<number, ContentBlock[]>(); // 먼저 도착해 기다리는 조각
  private readonly gaps = new Set<number>(); // 포기한(누락) seq
  private readonly window: number;
  private dup = 0;
  private lateCount = 0;

  constructor(opts: ChunkAssemblerOptions = {}) {
    const window = opts.window ?? 16;
    if (!Number.isInteger(window) || window < 0) throw new RangeError('window must be a non-negative integer');
    this.window = window;
  }

  /** Number of chunks dropped because their seq was already seen. */
  get duplicates(): number {
    return this.dup;
  }

  /** Chunks that arrived after their seq had already been given up as missing (they stay in `missing`). */
  get late(): number {
    return this.lateCount;
  }

  /** Feed one received chunk; returns the chunks that can now be emitted in order. */
  push(seq: number, content: ContentBlock[]): ChunkEvent[] {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.next + MAX_SEQ_JUMP) {
      throw new RangeError(`bad seq ${seq}`);
    }
    if (seq < this.next) {
      // 이미 내보낸 seq — 중복이거나, 누락으로 포기한 뒤 늦게 온 조각
      if (this.gaps.has(seq)) this.lateCount += 1;
      else this.dup += 1;
      return [];
    }
    if (this.pending.has(seq)) {
      this.dup += 1;
      return [];
    }
    this.pending.set(seq, content);
    const out = this.drain();
    // 기다리는 조각이 창보다 많으면 빈칸을 누락으로 포기하고 앞으로 나간다(메모리 상한).
    while (this.pending.size > this.window) {
      this.skipToLowestPending();
      out.push(...this.drain());
    }
    return out;
  }

  /**
   * The call is over: emit everything still waiting (gaps become missing).
   * @param expected total chunk count announced by the server, if known — catches lost chunks at the tail.
   */
  finish(expected?: number): { flushed: ChunkEvent[]; missing: number[] } {
    const flushed: ChunkEvent[] = [];
    while (this.pending.size > 0) {
      this.skipToLowestPending();
      flushed.push(...this.drain());
    }
    if (expected !== undefined && expected - this.next <= MAX_SEQ_JUMP) {
      // 끝쪽 누락: 서버는 N개를 보냈다는데 그보다 적게 받은 경우
      for (let seq = this.next; seq < expected; seq++) this.gaps.add(seq);
      if (expected > this.next) this.next = expected;
    }
    return { flushed, missing: [...this.gaps].sort((a, b) => a - b) };
  }

  private drain(): ChunkEvent[] {
    const out: ChunkEvent[] = [];
    for (;;) {
      const content = this.pending.get(this.next);
      if (content === undefined) return out;
      this.pending.delete(this.next);
      out.push({ type: 'chunk', seq: this.next, content });
      this.next += 1;
    }
  }

  private skipToLowestPending(): void {
    const lowest = Math.min(...this.pending.keys());
    for (let seq = this.next; seq < lowest; seq++) this.gaps.add(seq);
    this.next = lowest;
  }
}
