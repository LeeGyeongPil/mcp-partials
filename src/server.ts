// 서버 쪽: async generator 로 쓴 도구 본문을 공식 SDK 핸들러로 바꾼다.
// yield 한 조각은 notifications/progress 의 _meta 에 실려 바로 나가고,
// 생성기가 끝나면 권위 있는 최종 결과(CallToolResult)를 돌려준다.
import { adaptServerExtra, looksLikeHandlerExtra } from './adapters.js';
import { Coalescer } from './coalesce.js';
import { metaCodec, toContentBlocks, type ChunkCodec } from './codec.js';
import { buildErrorResult, buildFinalResult } from './final.js';
import type { CallToolResult, ChunkInput, ContentBlock, SdkFlavor } from './types.js';

/** Second argument of your generator. */
export interface StreamContext {
  /** Aborted when the caller cancels the request. Pass it to fetch()/child processes. */
  signal: AbortSignal;
  /** True when the caller asked for progress (has a progressToken), i.e. chunks will actually be sent. */
  streaming: boolean;
  /** The original SDK handler argument (v1 `extra` or v2 `ctx`). */
  raw: unknown;
}

export interface StreamingToolOptions {
  /** Batch chunks yielded within this many ms into one notification. 0 (default) sends each chunk at once. */
  coalesceMs?: number;
  /** Optional `total` for every progress notification. */
  total?: number;
  /** Text for the spec `message` field (what chunk-unaware hosts may show). Default: the chunk's text, shortened. */
  message?: (content: ContentBlock[], seq: number) => string | undefined;
  /** Where chunks go inside the notification. Default `metaCodec`. */
  codec?: ChunkCodec;
  /** Force the SDK flavour instead of detecting it from the handler argument. */
  sdk?: SdkFlavor;
}

export type StreamingGenerator<A> = (
  args: A,
  ctx: StreamContext,
) => AsyncGenerator<ChunkInput, CallToolResult | string | void, undefined>;

const MESSAGE_LIMIT = 200;

/**
 * Wrap an async generator as an MCP tool handler for `server.registerTool(name, config, handler)`.
 * Works with SDK v1 (`(args, extra)`) and v2 (`(args, ctx)`), and with tools that have no input schema.
 */
export function streamingTool<A = Record<string, unknown>>(
  gen: StreamingGenerator<A>,
  opts: StreamingToolOptions = {},
): (args: A, extra?: any) => Promise<CallToolResult> {
  const codec = opts.codec ?? metaCodec;
  const coalesceMs = opts.coalesceMs ?? 0;

  return async function streamingToolHandler(first: A, second?: unknown): Promise<CallToolResult> {
    // 입력 스키마가 없는 도구는 SDK 가 (extra) 하나만 넘긴다.
    const noArgs = second === undefined && looksLikeHandlerExtra(first);
    const args = (noArgs ? {} : first) as A;
    const req = adaptServerExtra(noArgs ? first : second, opts.sdk);
    const { signal, progressToken } = req;
    // 토큰이 없으면(onprogress 없이 부른 클라이언트) 조각을 보낼 수 없다 → 최종 결과에만 담는다.
    const streaming = progressToken !== undefined;

    const yielded: ContentBlock[] = []; // 최종 결과를 만들 재료(조각을 보내든 안 보내든 모은다)
    let seq = 0; // 조각 순번(_meta 안) — 0부터
    let progress = 0; // 스펙의 progress — 알림마다 1씩, 엄격 증가(MUST)
    let sendFailed = false;
    let sendChain: Promise<void> = Promise.resolve(); // 알림을 한 줄로 세워 순서를 지킨다

    const sendChunk = (content: ContentBlock[]): void => {
      if (!streaming || signal.aborted || sendFailed) return;
      const chunkSeq = seq++;
      progress += 1;
      const params: Record<string, unknown> = {
        progressToken,
        progress,
        // 조각 데이터는 _meta 안에만 — 최상위 임의 필드는 SDK 스키마가 지운다
        _meta: codec.encode(chunkSeq, content),
      };
      if (opts.total !== undefined) params['total'] = opts.total;
      const message = opts.message ? opts.message(content, chunkSeq) : defaultMessage(content);
      if (message !== undefined) params['message'] = message;
      sendChain = sendChain
        .then(() => (signal.aborted ? undefined : req.notify({ method: 'notifications/progress', params })))
        .catch(() => {
          sendFailed = true; // 전송이 끊기면 조각은 그만 보내고 최종 결과로 마감
        });
    };

    const coalescer = new Coalescer(coalesceMs, sendChunk);
    const it = gen(args, { signal, streaming, raw: noArgs ? first : second });
    let generatorDone = false; // 생성기가 스스로 끝났거나 throw 했으면 true

    // 취소 알림이 오면 기다리던 next() 를 놓고 바로 빠져나온다.
    // (반복마다 새 Promise 를 만들어 Promise.race 의 반응 누적을 피한다)
    let wake: ((value: 'aborted') => void) | undefined;
    const onAbort = (): void => wake?.('aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        const step = await new Promise<IteratorResult<ChunkInput, CallToolResult | string | void> | 'aborted'>(
          (resolve, reject) => {
            wake = resolve;
            if (signal.aborted) resolve('aborted');
            it.next().then(resolve, (error: unknown) => {
              generatorDone = true; // 생성기 본문이 throw 함
              reject(error);
            });
          },
        );
        wake = undefined;
        if (step === 'aborted') {
          coalescer.dispose();
          // SDK 는 취소된 요청의 응답을 보내지 않는다 — 형식만 맞춘 결과
          return buildErrorResult(new Error('cancelled'), seq);
        }
        if (step.done) {
          generatorDone = true;
          coalescer.flush();
          await sendChain; // 모든 조각이 최종 결과보다 먼저 나가도록
          return buildFinalResult(step.value, yielded, seq);
        }
        const content = toContentBlocks(step.value); // 잘못된 값이면 BAD_CHUNK
        yielded.push(...content);
        coalescer.add(content);
      }
    } catch (error) {
      // 생성기가 throw 했거나 잘못된 값을 yield 함 — 이미 보낸 조각은 두고 isError 결과
      coalescer.flush();
      await sendChain;
      return buildErrorResult(error, seq);
    } finally {
      wake = undefined;
      coalescer.dispose();
      signal.removeEventListener('abort', onAbort);
      // 끝나지 않은 생성기는 return() 으로 닫아 그 finally(파일·프로세스 정리)가 돌게 한다.
      if (!generatorDone) it.return(undefined).catch(() => undefined);
    }
  };
}

function defaultMessage(content: ContentBlock[]): string | undefined {
  const text = content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type}]`))
    .join('')
    .trim();
  if (text === '') return undefined;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}
