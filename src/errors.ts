/** Error codes raised by mcp-partials itself (protocol errors from the SDK pass through unchanged). */
export type PartialsErrorCode = 'UNSUPPORTED_SDK' | 'BAD_CHUNK' | 'ABORTED';

/** An error raised by mcp-partials. Check `code` to tell the cases apart. */
export class PartialsError extends Error {
  readonly code: PartialsErrorCode;

  constructor(code: PartialsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PartialsError';
    this.code = code;
  }
}
