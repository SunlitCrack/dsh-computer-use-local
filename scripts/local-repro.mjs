// Local repro harness for three reported defects (fork-side, no DSH needed).
//   node scripts/local-repro.mjs [--title <substring>] [--app <name>]
// Speaks the kernel's JSON-line protocol directly against lib/uia.ps1 --serve,
// so nothing here depends on the cordis plugin or the DSH tool layer.
// Source is intentionally ASCII-only: this repo gets edited from Windows
// PowerShell 5.1, which mangles UTF-8 on Get-Content/Set-Content round trips.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'uia.ps1');

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const titleNeedle = argOf('--title');
const appNeedle = argOf('--app');

const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KERNEL, '--serve'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});

// The kernel is strictly one request in -> one response line out, so responses
// are matched FIFO; it does not echo request ids.
let buf = '';
const pending = [];
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { console.log('[non-json]', line.slice(0, 200)); continue; }
    const waiter = pending.shift();
    if (waiter) waiter.resolve(obj);
    else console.log('[unsolicited]', JSON.stringify(obj).slice(0, 200));
  }
});

function call(action, params = {}) {
  proc.stdin.write(JSON.stringify({ ...params, action }) + '\n');
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    pending.push(entry);
    setTimeout(() => {
      const at = pending.indexOf(entry);
      if (at >= 0) { pending.splice(at, 1); reject(new Error(`timeout: ${action}`)); }
    }, 60000);
  });
}

const pad = (n, w = 3) => String(n).padStart(w);
const section = (label, value) => console.log(`\n=== ${label} ===\n${value}`);

try {
  const apps = await call('list_apps');
  const windows = apps.apps ?? [];
  console.log('windows seen by list_apps:', windows.length);
  for (const w of windows) {
    console.log(`  ${pad(w.pid, 6)} hwnd=${pad(w.hwnd, 8)} app=${JSON.stringify(w.app)} title=${JSON.stringify(w.title)}`);
  }

  const target = windows.find((w) => (
    (titleNeedle === undefined || String(w.title ?? '').includes(titleNeedle))
    && (appNeedle === undefined || w.app === appNeedle)
  ));
  if (!target) throw new Error(`no window matched title=${titleNeedle} app=${appNeedle}`);
  console.log(`\ntarget: app=${target.app} pid=${target.pid} hwnd=${target.hwnd} title=${JSON.stringify(target.title)}`);

  // ------------------------------------------------------------ P5: name resolution
  const byName = await call('get_state', { app: target.app, includeScreenshot: false });
  const byPid = await call('get_state', { app: `pid:${target.pid}`, includeScreenshot: false });
  const byHwnd = await call('get_state', { app: `hwnd:${target.hwnd}`, includeScreenshot: false });
  const fmt = (r) => (r.ok ? `ok hwnd=${r.window?.hwnd} process=${r.window?.processName}` : `FAILED: ${r.error}`);
  section('P5 by app name', `${JSON.stringify(target.app)} -> ${fmt(byName)}`);
  section('P5 by pid', `pid:${target.pid} -> ${fmt(byPid)}`);
  section('P5 by hwnd', `hwnd:${target.hwnd} -> ${fmt(byHwnd)}`);

  const state = byPid.ok ? byPid : byHwnd;
  if (!state.ok) throw new Error('no usable get_state result');
  const bounds = state.window.bounds;
  section('window bounds (screen px)', JSON.stringify(bounds));

  // --------------------------------------- P3: index -> element mapping integrity
  const printed = new Map();
  for (const line of String(state.text ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+\S+.*?frame=\[(-?\d+),(-?\d+),(\d+),(\d+)\]\s*$/);
    if (m) printed.set(Number(m[1]), { x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
  }
  const elements = state.elements ?? [];
  const mismatches = [];
  for (const el of elements) {
    const p = printed.get(el.index);
    if (!p) { mismatches.push({ index: el.index, why: 'element not printed in tree text' }); continue; }
    if (p.x !== el.frame.x || p.y !== el.frame.y || p.w !== el.frame.width || p.h !== el.frame.height) {
      mismatches.push({ index: el.index, printed: p, stored: el.frame });
    }
  }
  section('P3 index map', `elements=${elements.length} printedLines=${printed.size} mismatches=${mismatches.length}`);
  if (mismatches.length) console.log(JSON.stringify(mismatches.slice(0, 6), null, 1));

  // Probe the element path end to end: select a ListItem by element_index and
  // read back which item the shell reports as selected.
  const items = elements.filter((e) => e.role === 'ListItem' && e.name && e.secondaryActions?.includes('SelectionItem'));
  const victim = items[Math.floor(items.length / 2)] ?? items[0];
  if (!victim) {
    console.log('\nno ListItem with SelectionItem to probe in this window');
  } else {
    section('P3 probe target', `index=${victim.index} name=${JSON.stringify(victim.name)} frame=${JSON.stringify(victim.frame)} path=${victim.path}`);
    const center = { x: victim.frame.x + victim.frame.width / 2, y: victim.frame.y + victim.frame.height / 2 };
    console.log('expected screenshot-space center:', JSON.stringify(center),
      '-> screen:', JSON.stringify({ x: Math.round(bounds.x + center.x), y: Math.round(bounds.y + center.y) }));

    const act = await call('perform_secondary_action', {
      app: `hwnd:${state.window.hwnd}`,
      element_index: victim.index,
      action: 'SelectionItem',
      snapshot_hwnd: state.window.hwnd,
    });
    section('P4 action receipt', JSON.stringify(act));

    const after = await call('get_state', { app: `hwnd:${state.window.hwnd}`, includeScreenshot: false });
    const selLines = String(after.text ?? '').split('\n').filter((l) => /Selected|selected|\u9009\u4e2d/.test(l));
    section('P3 selected after action', selLines.join('\n') || '(no selection line)');
    console.log('\nrequested:', JSON.stringify(victim.name));
  }
} catch (err) {
  console.error('HARNESS ERROR:', err?.message ?? err);
} finally {
  try { proc.stdin.end(); } catch {}
  setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 300);
}
