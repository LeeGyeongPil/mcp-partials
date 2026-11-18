// 최종 결과 만들기: 조각 합치기(인접 text 블록 병합), 반환값 정규화, 조각 개수 표시.
import { PARTIALS_FINAL_KEY, isRecord } from './codec.js';
import type { CallToolResult, ContentBlock } from './types.js';

/**
 * Join content blocks, merging neighbouring plain text blocks into one.
 * Blocks with extra fields (annotations, _meta) are kept as they are.
 */
export function mergeContent(blocks: readonly ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last !== undefined && isPlainText(last) && isPlainText(block)) {
      // 인접한 text 블록은 하나로 이어 붙인다 — "alpha " + "beta" → "alpha beta"
      out[out.length - 1] = { type: 'text', text: (last.text as string) + (block.text as string) };
    } else {
      out.push(block);
    }
  }
  return out;
}

function isPlainText(block: ContentBlock): boolean {
  return block.type === 'text' && typeof block.text === 'string' && Object.keys(block).length === 2;
}

/**
 * Turn the generator's return value into the authoritative `CallToolResult`.
 * - `undefined` → everything that was yielded, merged
 * - `string` → one text block
 * - a `CallToolResult` → used as is
 * Then stamp `_meta["io.github.mcp-partials/final"] = { chunks }`.
 */
export function buildFinalResult(
  returned: unknown,
  yielded: readonly ContentBlock[],
  chunksSent: number,
): CallToolResult {
  let result: CallToolResult;
  if (returned === undefined || returned === null) {
    result = { content: mergeContent(yielded) };
  } else if (typeof returned === 'string') {
    result = { content: [{ type: 'text', text: returned }] };
  } else if (isRecord(returned) && Array.isArray(returned['content'])) {
    result = { ...(returned as CallToolResult) };
  } else {
    throw new TypeError('a streaming tool must return undefined, a string, or a CallToolResult ({ content: [...] })');
  }
  return withFinalMeta(result, chunksSent);
}

/** Build an `isError` result for a generator that threw. */
export function buildErrorResult(error: unknown, chunksSent: number): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return withFinalMeta({ content: [{ type: 'text', text: message }], isError: true }, chunksSent);
}

function withFinalMeta(result: CallToolResult, chunksSent: number): CallToolResult {
  return { ...result, _meta: { ...(result._meta ?? {}), [PARTIALS_FINAL_KEY]: { chunks: chunksSent } } };
}

/** Read `_meta["io.github.mcp-partials/final"].chunks` from a result, if it survived the trip. */
export function readFinalChunkCount(result: unknown): number | undefined {
  if (!isRecord(result) || !isRecord(result['_meta'])) return undefined;
  const final = result['_meta'][PARTIALS_FINAL_KEY];
  if (!isRecord(final)) return undefined;
  const chunks = final['chunks'];
  return Number.isInteger(chunks) && (chunks as number) >= 0 ? (chunks as number) : undefined;
}
