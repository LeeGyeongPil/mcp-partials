// ChunkAssembler·코덱·최종 결과 조립의 순수 로직 단위 테스트(SDK 없이).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChunkAssembler,
  PARTIALS_META_KEY,
  PartialsError,
  mergeContent,
  metaCodec,
  toContentBlocks,
  type ContentBlock,
} from 'mcp-partials';

const t = (text: string): ContentBlock[] => [{ type: 'text', text }];

test('assembler reorders, drops duplicates, reports gaps and tail loss', () => {
  const a = new ChunkAssembler();
  assert.deepEqual(a.push(1, t('b')), []); // 0 을 기다린다
  assert.deepEqual(
    a.push(0, t('a')).map((e) => e.seq),
    [0, 1],
  );
  assert.deepEqual(a.push(1, t('b')), []); // 이미 내보낸 seq → 중복
  assert.deepEqual(a.push(3, t('d')), []); // 2 를 기다린다
  assert.deepEqual(a.push(3, t('d')), []); // 기다리는 중인 seq → 중복
  assert.equal(a.duplicates, 2);
  const { flushed, missing } = a.finish(6); // 서버는 6개(0..5)를 보냈다
  assert.deepEqual(
    flushed.map((e) => e.seq),
    [3],
  );
  assert.deepEqual(missing, [2, 4, 5]);
});

test('assembler gives up on a gap when the window overflows', () => {
  const a = new ChunkAssembler({ window: 2 });
  assert.deepEqual(a.push(1, t('1')), []);
  assert.deepEqual(a.push(2, t('2')), []);
  // 세 번째로 기다리는 조각 → 창(2) 초과 → seq 0 을 누락으로 포기하고 1,2,3 을 내보낸다
  assert.deepEqual(
    a.push(3, t('3')).map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(a.push(0, t('0')), []); // 포기한 뒤 늦게 온 조각
  assert.equal(a.late, 1);
  assert.equal(a.duplicates, 0);
  assert.deepEqual(a.finish().missing, [0]);
});

test('assembler rejects absurd seqs', () => {
  const a = new ChunkAssembler();
  assert.throws(() => a.push(-1, t('x')), RangeError);
  assert.throws(() => a.push(1.5, t('x')), RangeError);
  assert.throws(() => a.push(10_000_000, t('x')), RangeError);
  assert.deepEqual(a.finish(10_000_000).missing, [], 'absurd expected count is ignored');
});

test('metaCodec round-trips and rejects malformed chunks', () => {
  const meta = metaCodec.encode(4, t('hi'));
  assert.deepEqual(meta, { [PARTIALS_META_KEY]: { seq: 4, content: t('hi') } });
  assert.deepEqual(metaCodec.decode({ progress: 1, _meta: meta }), { seq: 4, content: t('hi') });
  assert.equal(metaCodec.decode({ progress: 1 }), undefined, 'plain progress has no chunk');
  assert.throws(
    () => metaCodec.decode({ _meta: { [PARTIALS_META_KEY]: { seq: 'x', content: [] } } }),
    (e: unknown) => e instanceof PartialsError && e.code === 'BAD_CHUNK',
  );
  assert.throws(
    () => metaCodec.decode({ _meta: { [PARTIALS_META_KEY]: { seq: 0, content: 7 } } }),
    (e: unknown) => e instanceof PartialsError && e.code === 'BAD_CHUNK',
  );
});

test('toContentBlocks and mergeContent', () => {
  assert.deepEqual(toContentBlocks('x'), t('x'));
  assert.deepEqual(toContentBlocks({ type: 'text', text: 'y' }), t('y'));
  assert.throws(() => toContentBlocks({ type: 'text' } as unknown as ContentBlock), PartialsError);
  const image = { type: 'image', data: 'AA', mimeType: 'image/png' };
  const annotated = { type: 'text', text: 'keep', annotations: { priority: 1 } };
  assert.deepEqual(mergeContent([...t('a'), ...t('b'), image, ...t('c'), annotated, ...t('d')]), [
    { type: 'text', text: 'ab' },
    image,
    { type: 'text', text: 'c' },
    annotated,
    { type: 'text', text: 'd' },
  ]);
});
