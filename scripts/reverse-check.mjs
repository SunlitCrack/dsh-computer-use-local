// Reverse check: revert each fix in a throwaway copy and confirm the suite fails.
// A test that stays green when its fix is removed protects nothing — that is how
// the null-note and de-dup defects shipped in the first place.
//
// Anchors are regexes because the working tree may be checked out CRLF while the
// diff text is LF; literal multi-line strings break on that difference alone.
//
// Usage (repo root, with node_modules/@deepseek-ai/{dsh-tools,schemastery,cosmokit}):
//   node scripts/reverse-check.mjs
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolsPath = join(repo, 'lib', 'tools.js');
const original = readFileSync(toolsPath, 'utf8');

const FINAL_POINT = /const finalPoint = kernelPoint\r?\n\s*\? \(kind === 'click' && b\r?\n\s*\? \{ x: kernelPoint\.x \+ b\.x, y: kernelPoint\.y \+ b\.y \}\r?\n\s*: kernelPoint\)\r?\n\s*: fallback;/;

const cases = [
  {
    // Two mechanisms drop the null: a targeted `delete merged.note` and the
    // blanket sweep. Reverting only the targeted line leaves the blanket one in
    // place, so the suite stays green — correctly, because the behaviour still
    // holds. Revert BOTH to reproduce the original defect.
    name: 'null note is dropped (both mechanisms)',
    from: /if \(merged\.note == null\) delete merged\.note;/,
    to: '/* reverted */',
    also: [
      {
        from: /if \(merged\[key\] === null && key !== 'ok'\) delete merged\[key\];/,
        to: '/* reverted */',
      },
    ],
  },
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
  {
    // P3 identity recovery is exercised by test/kernel-safety.test.mjs, whose
    // cases come from a PowerShell fixture that whitelists kernel functions.
    // Dropping Find-ElementByIdentity reproduces the state before 0.3.2-local.7,
    // when the recovery path could not be reached at all.
    name: 'P3 identity recovery (kernel-safety)',
    test: 'test/kernel-safety.test.mjs',
    file: 'test/fixtures/kernel-safety.ps1',
    from: /,\r?\n\s*# Recovering a drifted path by identity needs this lookup[\s\S]*?'Find-ElementByIdentity',/,
    to: ',',
  },
];

/** Run the suite in `dir` and return the names of failing CASES (not files). */
function failingTests(dir, testFile) {
  try {
    execFileSync(process.execPath, ['--test', testFile], {
      cwd: dir, stdio: 'pipe', timeout: 180000, encoding: 'utf8',
    });
    return { failed: [], crashed: false };
  } catch (error) {
    const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    const failed = new Set();
    for (const line of text.split(/\r?\n/)) {
      // Case-level failures look like "✖ click by x/y: ... (4.7ms)".
      // File-level ones look like "✖ test\output-schema.test.mjs (79.7ms)" and
      // must NOT count: a copy whose imports crash produces only those, and
      // treating them as failures made this script print PASS for every revert.
      const m = line.match(/^\s*✖\s+(.+?)\s+\([\d.]+ms\)\s*$/);
      if (!m) continue;
      const name = m[1].trim();
      if (/\.(mjs|cjs|js)$/.test(name)) continue;
      failed.add(name);
    }
    // A copy that cannot even import the test is not evidence about the fix.
    const crashed = failed.size === 0;
    return { failed: [...failed], crashed };
  }
}

/**
 * Give the throwaway copy a resolvable @deepseek-ai tree.
 *
 * The copy excludes node_modules so it stays cheap, but the tests import
 * @deepseek-ai/dsh-tools (for validateJsonSchemaValue). Without this the copy
 * cannot even load and every "failure" is an import crash, not a test result —
 * which is exactly how this script used to report PASS for every revert.
 * Sources: the local repo if it has them, otherwise the running DSH install.
 */
function linkNodeModules(dir) {
  const targets = [
    join(repo, 'node_modules'),
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules'),
    // The profile does not ship dsh-tools; the harness install does.
    join('D:\\DeepSeek Harness', 'resources', 'app', 'dsh', 'node_modules'),
  ];
  const host = targets.find((p) => {
    try { readFileSync(join(p, '@deepseek-ai', 'dsh-tools', 'package.json')); return true; } catch { return false; }
  });
  if (!host) {
    throw new Error('reverse-check needs @deepseek-ai/dsh-tools; install deps or run where the profile does');
  }
  const dest = join(dir, 'node_modules');
  try {
    symlinkSync(host, dest, 'junction');
  } catch {
    cpSync(host, dest, { recursive: true });
  }
}

const dirs = [];
let failures = 0;
for (const c of cases) {
  // Each case names the file it edits and the test it expects to go red; the
  // default targets the tool layer.
  const targetFile = c.file ?? 'lib/tools.js';
  const targetPath = join(repo, targetFile);
  const targetSource = readFileSync(targetPath, 'utf8');
  if (!c.from.test(targetSource)) {
    console.log(`SKIP  ${c.name}: anchor did not match in ${targetFile} — the fix moved, update this check`);
    failures++;
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cu-reverse-'));
  dirs.push(dir);
  cpSync(repo, dir, {
    recursive: true,
    // Exclude .git and node_modules by path SEGMENT. The previous
    // `join('') + '.git'` produced '..git', which matched nothing, so .git was
    // copied; and excluding node_modules left the copy unable to resolve
    // @deepseek-ai/dsh-tools, so every copy "failed" to import.
    filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src),
  });
  linkNodeModules(dir);
  writeFileSync(join(dir, targetFile), targetSource.replace(c.from, c.to));
  // A fix may be carried by more than one mechanism; revert them together or the
  // remaining one keeps the behaviour (and the test green).
  for (const extra of c.also ?? []) {
    const path = join(dir, extra.file ?? targetFile);
    const source = readFileSync(path, 'utf8');
    if (!extra.from.test(source)) {
      console.log(`SKIP  ${c.name}: secondary anchor did not match in ${extra.file ?? targetFile}`);
      failures++;
      continue;
    }
    writeFileSync(path, source.replace(extra.from, extra.to));
  }
  const { failed, crashed } = failingTests(dir, c.test ?? 'test/output-schema.test.mjs');
  if (crashed) {
    console.log(`FAIL  reverting "${c.name}": the copy could not run the test at all (check node_modules)`);
    failures++;
  } else if (failed.length === 0) {
    console.log(`FAIL  reverting "${c.name}" breaks nothing — the suite does not cover it`);
    failures++;
  } else {
    console.log(`PASS  reverting "${c.name}" fails ${failed.length} case(s): ${failed.join(' | ')}`);
  }
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log('');
console.log(failures === 0
  ? 'REVERSE CHECK PASSED — every fix is load-bearing'
  : `${failures} fix(es) are not covered by any failing test`);
process.exit(failures === 0 ? 0 : 1);
