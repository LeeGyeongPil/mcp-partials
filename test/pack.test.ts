// AC-10: npm pack 결과를 임시 프로젝트에 설치해 두 진입점(. / ./testing)·타입 선언·런타임 의존성 0 을 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)); // build-test/test/ → 레포 루트
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

test('packed tarball exposes both entry points with types and zero runtime deps', () => {
  assert.ok(existsSync(join(repoRoot, 'dist/index.js')), 'run `npm run build` first (npm test does it)');
  const work = mkdtempSync(join(tmpdir(), 'mcp-partials-pack-'));
  try {
    // 1) npm pack — dist 는 이미 빌드됨(pretest), prepack 스크립트는 건너뛴다
    const packed = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work], repoRoot)) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const info = packed[0]!;
    const files = info.files.map((f) => f.path);
    for (const f of ['dist/index.js', 'dist/index.d.ts', 'dist/testing/index.js', 'dist/testing/index.d.ts', 'package.json', 'LICENSE']) {
      assert.ok(files.includes(f), `tarball contains ${f}`);
    }
    assert.ok(!files.some((f) => f.startsWith('src/') || f.startsWith('test/') || f.startsWith('build-test/')), 'no sources/tests in tarball');

    // 2) 빈 프로젝트에 설치(네트워크 없이 — 런타임 의존성이 없으니 받을 것이 없다)
    const app = join(work, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
    run(npm, ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', join(work, info.filename)], app);

    const installed = JSON.parse(readFileSync(join(app, 'node_modules/mcp-partials/package.json'), 'utf8'));
    assert.deepEqual(installed.dependencies ?? {}, {}, 'no runtime dependencies');
    assert.ok(existsSync(join(app, 'node_modules/mcp-partials', installed.exports['.'].types)));
    assert.ok(existsSync(join(app, 'node_modules/mcp-partials', installed.exports['./testing'].types)));

    // 3) 설치된 패키지를 이름으로 import
    writeFileSync(
      join(app, 'check.mjs'),
      [
        "import { streamingTool, callToolStream, PARTIALS_META_KEY } from 'mcp-partials';",
        "import { withChaos } from 'mcp-partials/testing';",
        'console.log(JSON.stringify([typeof streamingTool, typeof callToolStream, typeof withChaos, PARTIALS_META_KEY]));',
      ].join('\n'),
    );
    const out = run(process.execPath, ['check.mjs'], app);
    assert.deepEqual(JSON.parse(out), ['function', 'function', 'function', 'io.github.mcp-partials/chunk']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
