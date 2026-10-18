// Local verification for the fork's P1-P5 patches. Needs a real desktop.
//   node scripts/local-verify.mjs [--title <substring>]
// ASCII-only source on purpose (this repo is edited from PowerShell 5.1).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'uia.ps1');
const titleIdx = process.argv.indexOf('--title');
const titleNeedle = titleIdx >= 0 ? process.argv[titleIdx + 1] : undefined;

const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KERNEL, '--serve'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});

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
    try { obj = JSON.parse(line); } catch { console.log('[non-json]', line.slice(0, 300)); continue; }
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const section = (label) => console.log(`\n--- ${label} ---`);

const state = async (params) => call('get_state', { includeScreenshot: false, ...params });
const elementsOf = (st) => st.elements ?? [];

try {
  const apps = await call('list_apps');
  const windows = apps.apps ?? [];
  const target = windows.find((w) => (
    w.app !== 'Program Manager'
    && (titleNeedle === undefined ? w.app === 'explorer' : String(w.title ?? '').includes(titleNeedle))
  ));
  if (!target) throw new Error(`no target window (title=${titleNeedle})`);
  console.log(`target: ${target.app} pid=${target.pid} hwnd=${target.hwnd} title=${JSON.stringify(target.title)}`);

  section('P5 window selection');
  const byName = await state({ app: target.app });
  const byPid = await state({ app: `pid:${target.pid}` });
  console.log('by name ->', byName.ok ? `hwnd=${byName.window.hwnd} title=${JSON.stringify(byName.window.title)} pick=${JSON.stringify(byName.window.pick)}` : byName.error);
  console.log('by pid  ->', byPid.ok ? `hwnd=${byPid.window.hwnd}` : byPid.error);
  const nameIsFolderWindow = byName.ok && byName.window.title !== 'Program Manager' && byName.window.title !== '';
  check('P5 app-name resolves to a real app window (not the desktop shell)', nameIsFolderWindow,
    byName.ok ? JSON.stringify(byName.window.title) : String(byName.error));

  const base = byPid.ok ? byPid : byName;
  if (!base.ok) throw new Error('cannot read target state');
  const bounds = base.window.bounds;
  console.log('bounds:', JSON.stringify(bounds));

  section('P1/P2 unicode round trip (set_value on the search box)');
  const edits = elementsOf(base).filter((e) => e.role === 'Edit' && e.settable);
  const searchBox = edits.find((e) => /search/i.test(e.automationId) || e.name === '\u641c\u7d22\u6846') ?? edits[0];
  if (!searchBox) {
    check('P1 unicode round trip', false, 'no settable Edit in this window');
  } else {
    const probe = 'unicode \u9a8c\u6536 42';
    const w = await call('set_value', {
      app: `hwnd:${base.window.hwnd}`, path: searchBox.path,
      element_identity: { name: searchBox.name, automationId: searchBox.automationId, role: searchBox.role },
      value: probe, snapshot_hwnd: base.window.hwnd,
    });
    const after = await state({ app: `hwnd:${base.window.hwnd}` });
    // Match by AutomationId/role: the path can shift when the provider rebuilds.
    const same = elementsOf(after).find((e) => e.role === 'Edit'
      && (searchBox.automationId ? e.automationId === searchBox.automationId : e.path === searchBox.path));
    console.log('set_value ->', JSON.stringify(w));
    console.log('read back  ->', JSON.stringify(same?.value));
    check('P1 stdin UTF-8 round trip (CJK survives)', same?.value === probe, `${JSON.stringify(same?.value)} !== ${JSON.stringify(probe)}`);
    await call('set_value', {
      app: `hwnd:${base.window.hwnd}`, path: searchBox.path,
      element_identity: { name: searchBox.name, automationId: searchBox.automationId, role: searchBox.role },
      value: '', snapshot_hwnd: base.window.hwnd,
    });
  }

  section('P3 element identity vs positional path');
  const listItems = elementsOf(base).filter((e) => e.role === 'ListItem' && e.name && e.secondaryActions?.includes('SelectionItem'));
  if (listItems.length < 2) {
    check('P3 drift recovery', false, `need >=2 selectable ListItems, saw ${listItems.length}`);
  } else {
    const a = listItems[0];
    const b = listItems[1];
    console.log(`A: index=${a.index} path=${a.path} name=${JSON.stringify(a.name)}`);
    console.log(`B: index=${b.index} path=${b.path} name=${JSON.stringify(b.name)}`);

    // (1) Wrong path + right identity: the kernel must act on the identity.
    const drift = await call('perform_secondary_action', {
      app: `hwnd:${base.window.hwnd}`, path: a.path,
      element_identity: { name: b.name, automationId: b.automationId, role: b.role },
      secondary_action: 'SelectionItem', snapshot_hwnd: base.window.hwnd,
    });
    const afterDrift = await state({ app: `hwnd:${base.window.hwnd}` });
    const selected = elementsOf(afterDrift).filter((e) => e.role === 'ListItem'
      && elementsOf(afterDrift).some((x) => x.index === e.index && x.name === e.name));
    const statusLine = String(afterDrift.text ?? '').split('\n').find((l) => /Selected|selected|\u9009\u4e2d/.test(l)) ?? '';
    console.log('drift action ->', JSON.stringify(drift));
    console.log('status line  ->', statusLine.trim());
    const pickedB = statusLine.includes(b.name.slice(0, 18));
    check('P3 identity wins over a drifted path', drift.ok === true && (pickedB || String(drift.note ?? '').includes('drift')),
      `note=${JSON.stringify(drift.note)} status=${statusLine.trim().slice(0, 80)}`);

    // (2) Plain path route (no identity) must keep working when the tree is
    //     untouched -- activation is the thing that rebuilds Explorer's view,
    //     so this phase opts out of it.
    const pathOnly = await call('perform_secondary_action', {
      app: `hwnd:${base.window.hwnd}`, path: a.path, activate: false,
      secondary_action: 'SelectionItem', snapshot_hwnd: base.window.hwnd,
    });
    console.log('path-only (activate:false) ->', JSON.stringify(pathOnly));
    check('P3 plain path route still works', pathOnly.ok === true, JSON.stringify(pathOnly.error ?? pathOnly.via));

    // (3) A path that no longer exists AND carries no identity must fail loudly
    //     instead of acting on whatever now sits at those ordinals.
    const stale = await call('perform_secondary_action', {
      app: `hwnd:${base.window.hwnd}`, path: '9.9.9.9', activate: false,
      secondary_action: 'SelectionItem', snapshot_hwnd: base.window.hwnd,
    });
    console.log('stale path ->', JSON.stringify(stale));
    check('P3 stale path fails loudly', stale.ok === false && /no longer resolves/.test(String(stale.error)),
      String(stale.error).slice(0, 90));
  }

  section('P4 click receipt coordinates');
  const button = elementsOf(base).find((e) => e.role === 'Button' && e.secondaryActions?.includes('Invoke'));
  if (!button) {
    check('P4 receipt coordinates inside window bounds', false, 'no Invoke-capable Button in this window');
  } else {
    const clicked = await call('click', {
      app: `hwnd:${base.window.hwnd}`, path: button.path,
      element_identity: { name: button.name, automationId: button.automationId, role: button.role },
      snapshot_hwnd: base.window.hwnd, activate: false,
    });
    console.log('click ->', JSON.stringify(clicked));
    const inside = clicked.ok && clicked.x >= 0 && clicked.y >= 0
      && clicked.x <= bounds.width && clicked.y <= bounds.height;
    check('P4 receipt x/y are window-relative (inside bounds)', inside,
      `(${clicked.x}, ${clicked.y}) vs ${bounds.width}x${bounds.height}`);
  }
} catch (err) {
  console.error('VERIFY ERROR:', err?.message ?? err);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
  try { proc.stdin.end(); } catch {}
  setTimeout(() => { try { proc.kill(); } catch {} process.exit(failed.length === 0 ? 0 : 1); }, 300);
}
