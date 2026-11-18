# Changelog

## 0.1.0 — 2026-11-18

First release.

- `streamingTool(gen, opts)` — wrap an `async function*` as an MCP tool handler for the official TypeScript SDK v1 (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/server`). Yielded chunks go out as spec `notifications/progress` with the chunk in `_meta["io.github.mcp-partials/chunk"] = { seq, content }`; the final `CallToolResult` is always complete and carries `_meta["io.github.mcp-partials/final"] = { chunks }`.
- Options: `coalesceMs` (batch tiny chunks), `total`, `message`, `codec`, `sdk`.
- `callToolStream(client, params, opts)` / `collectToolStream(...)` — receive chunks in `seq` order without duplicates, then a `final` event with `streamed`, `chunks`, `missing`, `duplicates`. Supports `signal`, `timeoutMs`, `maxTotalTimeoutMs`, `reorderWindow`, `sdk`, `codec`.
- `ChunkAssembler` (reorder / de-duplicate / missing detection without any SDK), `metaCodec` and the `ChunkCodec` interface.
- `partialsCapability()`, `streamingToolMeta()`, `serverSupportsPartials(client)`.
- `mcp-partials/testing`: `withChaos(transport, { seed, duplicate, drop, reorder })` — seeded fault injection for progress notifications.
- Examples: `slow-grep`, `fallback-http`, `chaos`.
- Zero runtime dependencies; the SDKs are optional peer dependencies.
