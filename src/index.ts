// mcp-partials 공개 API.
export { streamingTool } from './server.js';
export type { StreamContext, StreamingToolOptions, StreamingGenerator } from './server.js';

export { callToolStream, collectToolStream } from './client.js';
export type { CallToolParams, CallToolStreamOptions, FinalEvent, ToolStream, ToolStreamEvent } from './client.js';

export { ChunkAssembler, MAX_SEQ_JUMP } from './assembler.js';
export type { ChunkAssemblerOptions, ChunkEvent } from './assembler.js';

export {
  PARTIALS_CAPABILITY_KEY,
  PARTIALS_FINAL_KEY,
  PARTIALS_META_KEY,
  metaCodec,
  toContentBlocks,
} from './codec.js';
export type { ChunkCodec, DecodedChunk } from './codec.js';

export { mergeContent } from './final.js';
export { PARTIALS_VERSION, partialsCapability, serverSupportsPartials, streamingToolMeta } from './capability.js';
export { detectClientSdk } from './adapters.js';
export { PartialsError } from './errors.js';
export type { PartialsErrorCode } from './errors.js';
export type { CallToolResult, ChunkInput, ContentBlock, SdkFlavor, TextContent, TransportLike } from './types.js';
