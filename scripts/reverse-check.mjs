// Reverse check: revert each fix in a throwaway copy and confirm the suite fails.
// A test that stays green when its fix is removed protects nothing — that is how
// the null-note and de-dup defects shipped in the first place.
//
// Anchors are regexes because the working tree may be checked out CRLF while the
// diff text is LF; literal multi-line strings break on that difference alone.
//
// Usage (repo root, with node_modules/@deepseek-ai/{dsh-tools,schemastery,cosmokit}):
//   node scripts/reverse-check.mjs
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolsPath = join(repo, 'lib', 'tools.js');
const original = readFileSync(toolsPath, 'utf8');

const FINAL_POINT = /const finalPoint = kernelPoint\r?\n\s*\? \(kind === 'click' && b\r?\n\s*\? \{ x: kernelPoint\.x \+ b\.x, y: kernelPoint\.y \+ b\.y \}\r?\n\s*: kernelPoint\)\r?\n\s*: fallback;/;

const cases = [
  { name: 'null note is dropped', from: /if \(merged\.note == null\) delete merged\.note;/, to: '/* reverted */' },
  {
    name: 'coordinate de-duplication',
    from: /const sameNumbers = value\.x != null && value\.captureX != null\r?\n\s*&& value\.x === value\.captureX && value\.y === value\.captureY;/,
    to: 'const sameNumbers = false;',
  },
  { name: 'amber ring conversion for click', from: FINAL_POINT, to: 'const finalPoint = kernelPoint ?? fallback;' },
  {
    name: 'scroll/drag left in screen space',
    from: FINAL_POINT,
    to: 'const finalPoint = kernelPoint ? (b ? { x: kernelPoint.x + b.x, y: kernelPoint.y + b.y } : kernelPoint) : fallback;',
  },
  {
    name: 'required ok survives the null sweep',
    from: /if \(merged\[key\] === null && key !== 'ok'\) delete merged\[key\];/,
    to: 'if (merged[key] === null) delete merged[key];',
  },
  { name: 'FAILED receipt branch', from: /const failed = value\.ok === false;/, to: 'const failed = false;' },
];

/** Run the suite in `dir` and return the names of failing tests. */
function failingTests(dir) {
  try {
    execFileSync(process.execPath, ['--test', 'test/output-schema.test.mjs'], {
      cwd: dir, stdio: 'pipe', timeout: 180000, encoding: 'utf8',
    });
    return [];
  } catch (error) {
    // node --test prints "✖ <name>" per failure; collect them from both streams.
    const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    const names = new Set();
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*[✖x]\s+(.+?)\s+\(\d/);
      if (m) names.add(m[1].trim());
    }
    return [...names];
  }
}

const dirs = [];
let failures = 0;
for (const c of cases) {
  if (!c.from.test(original)) {
    console.log(`SKIP  ${c.name}: anchor did not match — the fix moved, update this check`);
    failures++;
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cu-reverse-'));
  dirs.push(dir);
  cpSync(repo, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes(`${join('')}.git`),
  });
  writeFileSync(join(dir, 'lib', 'tools.js'), original.replace(c.from, c.to));
  const failed = failingTests(dir);
  if (failed.length === 0) {
    console.log(`FAIL  reverting "${c.name}" breaks nothing — the suite does not cover it`);
    failures++;
  } else {
    // Report what actually went red; more than one means the fix is entangled,
    // which is information, not a pass by itself.
    console.log(`PASS  reverting "${c.name}" fails ${failed.length} case(s): ${failed.join(' | ')}`);
  }
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('');
console.log(failures === 0
  ? 'REVERSE CHECK PASSED — every fix is load-bearing'
  : `${failures} fix(es) are not covered by any failing test`);
process.exit(failures === 0 ? 0 : 1);
