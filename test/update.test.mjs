// Update-reminder logic test (no network): version comparison ordering and
// the once-per-release / once-per-day reminder state machine, via injected
// fetch and state-file seams.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPluginUpdate, compareVersions } from '../lib/update.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- compareVersions ---------------------------------------------------------
check('compareVersions equal cores', compareVersions('0.2.0', '0.2.0') === 0);
check('compareVersions newer major', compareVersions('1.0.0', '0.9.9') > 0);
check('compareVersions newer minor', compareVersions('0.2.0', '0.1.9') > 0);
check('compareVersions newer patch', compareVersions('0.1.2', '0.1.1') > 0);
check('compareVersions older', compareVersions('0.1.0', '0.1.2') < 0);
check('compareVersions prerelease ignored on core', compareVersions('0.2.0-beta.1', '0.1.0') > 0);
check('compareVersions ragged length treats missing as zero', compareVersions('0.1.0', '0.1') === 0);
check('compareVersions garbage tolerant', compareVersions('abc', '0.1.0') < 0);

// --- state machine with a stub fetch ------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'cu-update-'));
const stateFile = join(dir, 'update.json');
const warns = [];
const logger = { warn: (m) => warns.push(m) };
let remoteVersion = '9.9.9';
const fetchImpl = async () => ({ ok: true, json: async () => ({ version: remoteVersion }) });
const now = 1_000_000_000_000;

await checkPluginUpdate(logger, { fetchImpl, stateFile, now });
check('first run with newer remote warns once', warns.length === 1, warns[0] ?? 'no warning');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check('warning mentions package and versions', new RegExp(`@milkuovo/dsh-computer-use ${pkg.version.replace(/\./g, '\\.')} → 9\\.9\\.9`).test(warns[0] ?? ''), warns[0]);
const state1 = JSON.parse(readFileSync(stateFile, 'utf8'));
check('state records seenVersion and lastChecked', state1.seenVersion === '9.9.9' && state1.lastChecked === now);

await checkPluginUpdate(logger, { fetchImpl, stateFile, now: now + 60_000 });
check('same release within 24h does not re-remind', warns.length === 1);

remoteVersion = '10.0.0';
await checkPluginUpdate(logger, { fetchImpl, stateFile, now: now + 60_000 });
check('newer release still throttled by 24h window', warns.length === 1);

await checkPluginUpdate(logger, { fetchImpl, stateFile, now: now + 24 * 3600_000 + 1 });
check('next day with newer release warns again', warns.length === 2, warns[1] ?? '');

remoteVersion = '0.2.0';
await checkPluginUpdate(logger, { fetchImpl, stateFile, now: now + 2 * 24 * 3600_000 });
check('remote not newer is silent', warns.length === 2);

// --- failure paths are silent -------------------------------------------------
let previous = warns.length;
await checkPluginUpdate(logger, { fetchImpl: async () => { throw new Error('offline'); }, stateFile, now: now + 3 * 24 * 3600_000 });
check('offline fetch is silent', warns.length === previous);
await checkPluginUpdate(logger, { fetchImpl: async () => ({ ok: false, status: 404 }), stateFile, now: now + 3 * 24 * 3600_000 });
check('non-ok response is silent', warns.length === previous);
await checkPluginUpdate(logger, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }), stateFile, now: now + 3 * 24 * 3600_000 });
check('malformed body is silent', warns.length === previous);
await checkPluginUpdate(null, { fetchImpl: async () => ({ ok: true, json: async () => ({ version: '11.0.0' }) }), stateFile, now: now + 3 * 24 * 3600_000 });
check('null logger does not throw', true);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
