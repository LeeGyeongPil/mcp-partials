// SDK 와 독립된 최소 구조적 타입.
// 런타임에 SDK 를 import 하지 않기 위해(런타임 의존성 0) 필요한 모양만 직접 적는다.
// v1(@modelcontextprotocol/sdk)·v2(@modelcontextprotocol/server·client) 의 실제 타입과
// 구조적으로 호환되도록 필드를 넓게 둔다.

/** A text content block (`{ type: 'text', text }`). */
export interface TextContent {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

/**
 * Any MCP content block (text, image, audio, resource_link, resource, ...).
 * Only `type` is required here so that blocks from either SDK version fit.
 */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/** The parts of a `tools/call` result this library reads and writes. */
export interface CallToolResult {
  // `any` on purpose (content, structuredContent): the result must be assignable to both
  // SDKs' narrower types when returned from a tool handler
  // (v1 structuredContent is an object, v2 allows any JSON value).
  content: any[];
  structuredContent?: any;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What a tool generator may `yield`: a string, one block, or a list of blocks. */
export type ChunkInput = string | ContentBlock | ContentBlock[];

/** Params of a `notifications/progress` notification (spec fields only). */
export interface ProgressParams {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
  _meta?: Record<string, unknown>;
}

/** A JSON-RPC message as seen by a transport (loose). */
export interface JsonRpcMessageLike {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/** The transport surface shared by SDK v1 and v2 (`start`/`send`/`close` + callbacks). */
export interface TransportLike {
  start(): Promise<void>;
  send(message: any, options?: any): Promise<void>;
  close(): Promise<void>;
  onmessage?: ((message: any, extra?: any) => void) | undefined;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

/** Which official SDK generation to talk to. `auto` detects it from object shape. */
export type SdkFlavor = 'auto' | 'v1' | 'v2';
