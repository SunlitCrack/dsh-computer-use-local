// Does reverse-check.mjs report PASS on a copy where NOTHING was reverted?
// If yes, its "every fix is load-bearing" verdict is worthless.
import { cpSync, rmSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

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
      const m = line.match(/^\s*✖\s+(.+?)\s+\([\d.]+ms\)\s*$/);
      if (!m) continue;
      const name = m[1].trim();
      if (/\.(mjs|cjs|js)$/.test(name)) continue;   // file-level, not a case
      failed.add(name);
    }
    return { failed: [...failed], crashed: failed.size === 0 };
  }
}

/**
 * Guard for scripts/reverse-check.mjs itself.
 *
 * reverse-check only proves something if a copy with NO fix reverted reports no
 * failing case. It used to fail that test: the copy had no node_modules (so the
 * test could not even import) and the failure regex captured the FILE line
 * ("✖ test\output-schema.test.mjs"), so any revert -- or none -- printed PASS.
 * Run this whenever you touch either script.
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
  if (!host) throw new Error('need @deepseek-ai/dsh-tools to run this check');
  try { symlinkSync(host, join(dir, 'node_modules'), 'junction'); } catch { cpSync(host, join(dir, 'node_modules'), { recursive: true }); }
}

// Rebuild the copy exactly the way reverse-check.mjs does -- no fixes reverted.
const dir = mkdtempSync(join(tmpdir(), 'cu-noop-'));
try {
  cpSync(repo, dir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src),
  });
  linkNodeModules(dir);
  const hasGit = (() => { try { readFileSync(join(dir, '.git', 'HEAD')); return true; } catch { return false; } })();
  const hasModules = (() => { try { readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')); return true; } catch { return false; } })();
  const { failed, crashed } = failingTests(dir, 'test/output-schema.test.mjs');
  console.log('copy has .git        :', hasGit, '(must be false)');
  console.log('copy has node_modules:', hasModules, '(must be true)');
  console.log('failingTests() on an UNMODIFIED copy ->', JSON.stringify(failed));
  const broken = hasGit || !hasModules || crashed || failed.length > 0;
  console.log(broken
    ? 'BROKEN: a no-op copy looks like a failed test, so reverse-check prints PASS for any revert'
    : 'OK: an unmodified copy reports no failing case, so a PASS from reverse-check means something');
  process.exit(broken ? 1 : 0);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
