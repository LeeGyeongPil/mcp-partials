// 타입 확인: streamingTool 의 인자 타입이 registerTool 의 inputSchema 에서 추론되는지(컴파일되면 통과).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as McpServerV2 } from '@modelcontextprotocol/server';
import { streamingTool } from 'mcp-partials';

test('argument types are inferred from the input schema (v1 and v2)', () => {
  const v1 = new McpServerV1({ name: 'types', version: '0.0.0' });
  v1.registerTool(
    'repeat',
    { inputSchema: { word: z.string(), times: z.number() } },
    streamingTool(async function* ({ word, times }) {
      // word: string, times: number — 타입 주석 없이 추론된다
      for (let i = 0; i < times; i++) yield word.toUpperCase();
    }),
  );
  const v2 = new McpServerV2({ name: 'types', version: '0.0.0' });
  v2.registerTool(
    'repeat',
    { inputSchema: z.object({ word: z.string(), times: z.number() }) },
    streamingTool(async function* ({ word, times }) {
      for (let i = 0; i < times; i++) yield word.toUpperCase();
      return `done ${times.toFixed(0)}`;
    }),
  );
  assert.ok(true);
});
