// 클라이언트 쪽: 공식 Client 의 callTool 을 부르면서 진행 알림(push)을 받아
// for await 로 꺼낼 수 있는 이벤트 줄(pull)로 바꾼다.
// 조각은 ChunkAssembler 로 순서를 세우고 중복을 거르며, 마지막에 권위 있는 최종 결과를 낸다.
import { adaptClientCall, type CallToolFn } from './adapters.js';
import { ChunkAssembler, type ChunkEvent } from './assembler.js';
import { metaCodec, type ChunkCodec } from './codec.js';
import { PartialsError } from './errors.js';
import { mergeContent, readFinalChunkCount } from './final.js';
import type { CallToolResult, ContentBlock, SdkFlavor } from './types.js';

export type { ChunkEvent } from './assembler.js';

/** The last event of every stream. `result` is always the complete answer. */
export interface FinalEvent {
  type: 'final';
  /** The authoritative tool result (identical whether or not chunks arrived). */
  result: CallToolResult;
  /** True when at least one chunk reached this client. */
  streamed: boolean;
  /** How many chunk events were emitted. */
  chunks: number;
  /** Chunk seqs that never arrived (or arrived too late), ascending. */
  missing: number[];
  /** How many repeated chunks were dropped. */
  duplicates: number;
}

export type ToolStreamEvent = ChunkEvent | FinalEvent;

export interface CallToolStreamOptions {
  /** Abort the call. Iteration then throws `PartialsError` with code `ABORTED`. */
  signal?: AbortSignal;
  /** SDK request timeout in ms (reset on every progress notification by default). */
  timeoutMs?: number;
  /** Hard upper bound in ms, even while chunks keep coming. */
  maxTotalTimeoutMs?: number;
  /** Reset `timeoutMs` whenever a progress notification arrives. Default true. */
  resetTimeoutOnProgress?: boolean;
  /** Out-of-order chunks to hold while waiting for a gap. Default 16. */
  reorderWindow?: number;
  /** Force `'v1'` or `'v2'` calling convention. Default `'auto'`. */
  sdk?: SdkFlavor;
  /** Must match the server's codec. Default `metaCodec`. */
  codec?: ChunkCodec;
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** An async iterable of chunk events followed by one final event. Iterate it once. */
export interface ToolStream extends AsyncIterable<ToolStreamEvent> {
  /** Resolves with the final event (starts the call if nobody iterates). */
  result(): Promise<FinalEvent>;
}

/**
 * Call a tool and receive its partial results as they arrive.
 *
 * ```ts
 * for await (const ev of callToolStream(client, { name: 'build', arguments: {} })) {
 *   if (ev.type === 'chunk') process.stdout.write(textOf(ev.content));
 *   else console.log(ev.result);
 * }
 * ```
 */
export function callToolStream(client: unknown, params: CallToolParams, opts: CallToolStreamOptions = {}): ToolStream {
  return new ToolStreamImpl(client, params, opts);
}

/** Collect a whole stream: chunk content merged, the final event, and whether they agree. */
export async function collectToolStream(
  client: unknown,
  params: CallToolParams,
  opts: CallToolStreamOptions = {},
): Promise<FinalEvent & { content: ContentBlock[]; matchesFinal: boolean | null }> {
  const parts: ContentBlock[] = [];
  let final: FinalEvent | undefined;
  for await (const ev of callToolStream(client, params, opts)) {
    if (ev.type === 'chunk') parts.push(...ev.content);
    else final = ev;
  }
  if (final === undefined) throw new Error('stream ended without a final event'); // 일어나지 않아야 함
  const content = mergeContent(parts);
  // 조각을 하나도 못 받았으면 비교할 수 없다(null). 아니면 합친 조각이 최종 content 와 같은지.
  const matchesFinal = final.chunks === 0 ? null : sameContent(content, mergeContent(final.result.content));
  return { ...final, content, matchesFinal };
}

function sameContent(a: ContentBlock[], b: ContentBlock[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Waiter = { resolve: (r: IteratorResult<ToolStreamEvent>) => void; reject: (e: unknown) => void };

class ToolStreamImpl implements ToolStream {
  private readonly queue: ToolStreamEvent[] = []; // 아직 꺼내 가지 않은 이벤트
  private waiter: Waiter | undefined; // next() 를 부르고 기다리는 소비자
  private started = false;
  private ended = false; // final 을 넣었거나 오류로 끝남
  private stopped = false; // 소비자가 break 함
  private error: unknown;
  private readonly controller = new AbortController();
  private readonly assembler: ChunkAssembler;
  private readonly codec: ChunkCodec;
  private emitted = 0;
  private unlinkSignal: (() => void) | undefined;
  private resolveFinal!: (final: FinalEvent) => void;
  private rejectFinal!: (error: unknown) => void;
  private readonly finalPromise: Promise<FinalEvent>;

  constructor(
    private readonly client: unknown,
    private readonly params: CallToolParams,
    private readonly opts: CallToolStreamOptions,
  ) {
    this.assembler = new ChunkAssembler({ window: opts.reorderWindow ?? 16 });
    this.codec = opts.codec ?? metaCodec;
    this.finalPromise = new Promise<FinalEvent>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    this.finalPromise.catch(() => undefined); // result() 를 안 부르는 사용자에게 unhandled rejection 이 나지 않게
  }

  result(): Promise<FinalEvent> {
    this.start();
    return this.finalPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<ToolStreamEvent> {
    this.start();
    return {
      next: () => this.next(),
      return: async () => {
        this.stop();
        return { done: true, value: undefined };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;

    // 사용자 signal → 내부 controller 로 연결(사용자 신호를 SDK 에 그대로 넘기지 않는 이유:
    // break 로 멈출 때도 같은 경로로 요청을 취소해야 하므로)
    const userSignal = this.opts.signal;
    if (userSignal) {
      if (userSignal.aborted) {
        this.fail(abortedError(userSignal.reason));
        return;
      }
      const onAbort = (): void => this.controller.abort(abortedError(userSignal.reason));
      userSignal.addEventListener('abort', onAbort, { once: true });
      this.unlinkSignal = () => userSignal.removeEventListener('abort', onAbort);
    }

    let callTool: CallToolFn;
    try {
      callTool = adaptClientCall(this.client, this.opts.sdk);
    } catch (error) {
      this.fail(error);
      return;
    }

    callTool(this.params, {
      // onprogress 를 주면 SDK 가 progressToken 을 만들어 요청에 붙이고, 그 토큰의 알림만 여기로 보낸다
      onprogress: (progress) => this.onProgress(progress),
      signal: this.controller.signal,
      resetTimeoutOnProgress: this.opts.resetTimeoutOnProgress ?? true,
      ...(this.opts.timeoutMs !== undefined ? { timeout: this.opts.timeoutMs } : {}),
      ...(this.opts.maxTotalTimeoutMs !== undefined ? { maxTotalTimeout: this.opts.maxTotalTimeoutMs } : {}),
    }).then(
      (result) => this.finish(result),
      (error: unknown) => this.fail(error),
    );
  }

  private onProgress(progress: Record<string, unknown>): void {
    if (this.ended) return;
    let chunk;
    try {
      chunk = this.codec.decode(progress);
    } catch {
      return; // 형식이 깨진 조각은 버린다 — 최종 결과가 정답이므로
    }
    if (chunk === undefined) return; // 조각 없는 평범한 진행 알림
    let ready: ChunkEvent[];
    try {
      ready = this.assembler.push(chunk.seq, chunk.content);
    } catch {
      return; // 터무니없는 seq
    }
    for (const ev of ready) this.emit(ev);
  }

  private finish(result: CallToolResult): void {
    if (this.ended) return;
    // 최종 결과 직전에 재정렬 버퍼를 비우고, 서버가 알린 조각 수로 끝쪽 누락까지 센다
    const { flushed, missing } = this.assembler.finish(readFinalChunkCount(result));
    for (const ev of flushed) this.emit(ev);
    const final: FinalEvent = {
      type: 'final',
      result,
      streamed: this.emitted > 0,
      chunks: this.emitted,
      missing,
      duplicates: this.assembler.duplicates,
    };
    this.push(final);
    this.ended = true;
    this.cleanup();
    this.resolveFinal(final);
  }

  private fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
    if (this.stopped) {
      // 소비자가 break 해서 우리가 취소한 것 — 오류가 아니다
      this.rejectFinal(abortedError('stream closed by consumer'));
      return;
    }
    const reason = this.opts.signal?.aborted ? abortedError(this.opts.signal.reason, error) : error;
    this.error = reason ?? new Error('tool call failed');
    this.rejectFinal(this.error);
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = undefined;
      reject(this.error);
    }
  }

  private emit(ev: ChunkEvent): void {
    this.emitted += 1;
    this.push(ev);
  }

  private push(ev: ToolStreamEvent): void {
    if (this.stopped) return; // break 뒤에는 쌓지 않는다
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: ev });
    } else {
      this.queue.push(ev);
    }
  }

  private next(): Promise<IteratorResult<ToolStreamEvent>> {
    const ev = this.queue.shift();
    if (ev !== undefined) return Promise.resolve({ done: false, value: ev });
    if (this.stopped) return Promise.resolve({ done: true, value: undefined });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** Consumer broke out of the loop: cancel the request (the SDK sends notifications/cancelled). */
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve({ done: true, value: undefined });
    }
    if (!this.ended) this.controller.abort(abortedError('stream closed by consumer'));
    else this.cleanup();
  }

  private cleanup(): void {
    this.unlinkSignal?.();
    this.unlinkSignal = undefined;
  }
}

function abortedError(reason: unknown, cause?: unknown): PartialsError {
  if (reason instanceof PartialsError && reason.code === 'ABORTED') return reason;
  const text = reason instanceof Error ? reason.message : reason === undefined ? 'aborted' : String(reason);
  return new PartialsError('ABORTED', `tool call aborted: ${text}`, { cause: cause ?? reason });
}
