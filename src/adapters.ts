// 공식 SDK v1·v2 의 차이를 한곳에서 흡수한다. SDK 를 import 하지 않고 객체 모양으로만 판별한다.
//
//                     v1 (@modelcontextprotocol/sdk)       v2 (@modelcontextprotocol/server·client)
// 핸들러 둘째 인자    extra.sendNotification / extra._meta   ctx.mcpReq.notify / ctx.mcpReq._meta
// 취소 신호           extra.signal                          ctx.mcpReq.signal
// client.callTool     (params, resultSchema, options)       (params, options)
import { PartialsError } from './errors.js';
import { isRecord } from './codec.js';
import type { CallToolResult, SdkFlavor } from './types.js';

/** What `streamingTool` needs from the handler's second argument, whatever the SDK. */
export interface ServerRequestHandle {
  sdk: 'v1' | 'v2';
  progressToken: string | number | undefined;
  signal: AbortSignal;
  notify(notification: { method: string; params: Record<string, unknown> }): Promise<void>;
}

/** Does this value look like a v1 `extra` or a v2 `ctx`? (used when a tool has no input schema) */
export function looksLikeHandlerExtra(value: unknown): boolean {
  return detectServerSdk(value) !== undefined;
}

function detectServerSdk(extra: unknown): 'v1' | 'v2' | undefined {
  if (!isRecord(extra)) return undefined;
  const mcpReq = extra['mcpReq'];
  if (isRecord(mcpReq) && typeof mcpReq['notify'] === 'function') return 'v2';
  if (typeof extra['sendNotification'] === 'function') return 'v1';
  return undefined;
}

export function adaptServerExtra(extra: unknown, sdk: SdkFlavor = 'auto'): ServerRequestHandle {
  const flavor = sdk === 'auto' ? detectServerSdk(extra) : sdk;
  if (flavor === undefined || !isRecord(extra)) {
    throw new PartialsError(
      'UNSUPPORTED_SDK',
      'streamingTool: the handler\'s second argument is neither an SDK v1 "extra" nor an SDK v2 "ctx". Pass { sdk: "v1" | "v2" } if you wrap it yourself.',
    );
  }
  if (flavor === 'v2') {
    const mcpReq = extra['mcpReq'] as Record<string, unknown>;
    const meta = isRecord(mcpReq['_meta']) ? mcpReq['_meta'] : undefined;
    const notify = mcpReq['notify'] as (n: unknown) => Promise<void>;
    return {
      sdk: 'v2',
      progressToken: readToken(meta),
      signal: readSignal(mcpReq['signal']),
      notify: (n) => notify(n),
    };
  }
  const meta = isRecord(extra['_meta']) ? extra['_meta'] : undefined;
  const sendNotification = extra['sendNotification'] as (n: unknown) => Promise<void>;
  return {
    sdk: 'v1',
    progressToken: readToken(meta),
    signal: readSignal(extra['signal']),
    notify: (n) => sendNotification(n),
  };
}

function readToken(meta: Record<string, unknown> | undefined): string | number | undefined {
  const token = meta?.['progressToken'];
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

function readSignal(value: unknown): AbortSignal {
  // 신호가 없는 경우(직접 부른 테스트 등)에는 절대 중단되지 않는 신호를 쓴다.
  return value instanceof AbortSignal ? value : new AbortController().signal;
}

/** Options forwarded to the SDK's `callTool` (names are the same in v1 and v2). */
export interface SdkRequestOptions {
  onprogress: (progress: Record<string, unknown>) => void;
  signal: AbortSignal;
  timeout?: number;
  maxTotalTimeout?: number;
  resetTimeoutOnProgress: boolean;
}

export type CallToolFn = (
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
  options: SdkRequestOptions,
) => Promise<CallToolResult>;

/**
 * Pick the right `callTool` calling convention.
 * v2 clients have `getNegotiatedProtocolVersion()`, v1 clients have `requestStream()`;
 * anything else (wrappers, mocks) must say which one with `sdk`.
 */
export function detectClientSdk(client: unknown): 'v1' | 'v2' {
  if (!isObjectLike(client) || typeof client['callTool'] !== 'function') {
    throw new PartialsError('UNSUPPORTED_SDK', 'callToolStream: expected an MCP Client with a callTool() method');
  }
  const v2 = typeof client['getNegotiatedProtocolVersion'] === 'function';
  const v1 = typeof client['requestStream'] === 'function';
  if (v2 && !v1) return 'v2';
  if (v1 && !v2) return 'v1';
  throw new PartialsError(
    'UNSUPPORTED_SDK',
    'callToolStream: cannot tell whether this Client is SDK v1 or v2. Pass { sdk: "v1" } or { sdk: "v2" }.',
  );
}

export function adaptClientCall(client: unknown, sdk: SdkFlavor = 'auto'): CallToolFn {
  if (!isObjectLike(client) || typeof client['callTool'] !== 'function') {
    throw new PartialsError('UNSUPPORTED_SDK', 'callToolStream: expected an MCP Client with a callTool() method');
  }
  const flavor = sdk === 'auto' ? detectClientSdk(client) : sdk;
  const callTool = client['callTool'] as (...args: unknown[]) => Promise<CallToolResult>;
  if (flavor === 'v1') {
    // v1: 둘째 인자는 결과 스키마 — undefined 면 SDK 기본값(CallToolResultSchema)
    return (params, options) => callTool.call(client, params, undefined, options);
  }
  return (params, options) => callTool.call(client, params, options);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}
