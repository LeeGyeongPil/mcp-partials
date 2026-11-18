// 조각을 진행 알림의 어디에 어떤 모양으로 싣는지 정하는 곳(코덱).
// 표준 부분 결과 필드가 정해지면 이 코덱만 바꿔 끼우면 된다.
import { PartialsError } from './errors.js';
import type { ChunkInput, ContentBlock } from './types.js';

/** `_meta` key that carries one chunk inside `notifications/progress`. */
export const PARTIALS_META_KEY = 'io.github.mcp-partials/chunk';
/** `_meta` key on the final `CallToolResult` that tells how many chunks were sent. */
export const PARTIALS_FINAL_KEY = 'io.github.mcp-partials/final';
/** Key under `capabilities.experimental` and the tool `_meta` marker prefix. */
export const PARTIALS_CAPABILITY_KEY = 'io.github.mcp-partials';

/** A decoded chunk: its sequence number and content blocks. */
export interface DecodedChunk {
  seq: number;
  content: ContentBlock[];
}

/**
 * Where a chunk lives inside a progress notification.
 * `encode` returns the object to put in `params._meta`; `decode` reads it back
 * (returns `undefined` when the notification carries no chunk).
 */
export interface ChunkCodec {
  encode(seq: number, content: ContentBlock[]): Record<string, unknown>;
  decode(progressParams: unknown): DecodedChunk | undefined;
}

/** Default codec: `params._meta["io.github.mcp-partials/chunk"] = { seq, content }`. */
export const metaCodec: ChunkCodec = {
  encode(seq, content) {
    return { [PARTIALS_META_KEY]: { seq, content } };
  },
  decode(progressParams) {
    if (!isRecord(progressParams)) return undefined;
    const meta = progressParams['_meta'];
    if (!isRecord(meta)) return undefined;
    const raw = meta[PARTIALS_META_KEY];
    if (raw === undefined) return undefined; // 조각이 없는 평범한 진행 알림
    if (!isRecord(raw) || !Number.isInteger(raw['seq']) || (raw['seq'] as number) < 0) {
      throw new PartialsError('BAD_CHUNK', 'chunk must be { seq: non-negative integer, content: ContentBlock[] }');
    }
    return { seq: raw['seq'] as number, content: toContentBlocks(raw['content'] as ChunkInput) };
  },
};

/**
 * Normalise what a tool yielded into a list of content blocks.
 * Throws `PartialsError('BAD_CHUNK')` for anything else (numbers, plain objects without `type`, ...).
 */
export function toContentBlocks(value: ChunkInput): ContentBlock[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (Array.isArray(value)) {
    for (const block of value) assertBlock(block);
    return value;
  }
  assertBlock(value);
  return [value];
}

function assertBlock(block: unknown): asserts block is ContentBlock {
  if (!isRecord(block) || typeof block['type'] !== 'string') {
    throw new PartialsError('BAD_CHUNK', `a chunk must be a string, a content block, or a list of content blocks (got ${describe(block)})`);
  }
  if (block['type'] === 'text' && typeof block['text'] !== 'string') {
    throw new PartialsError('BAD_CHUNK', 'a text block needs a string "text" field');
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
