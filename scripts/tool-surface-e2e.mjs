// E2E: exercise every non-click tool against real apps, one by one.
//   Chrome (isolated --user-data-dir, local test page):
//     scroll (page semantics + spy div), perform_secondary_action
//     (Toggle on checkbox, ExpandCollapse on <details>), type_text,
//     set_value, select_text on an input.
//   Notepad (fresh instance):
//     type_text, select_text + Delete, set_value, ctrl+a chord, drag
//     (title-bar drag moves the window; verified via window bounds).
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePowerShell } from '../lib/ps1.js';
import { buildTools } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- local test page -----------------------------------------------------------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>cu-e2e test page</title></head>
<body style="margin:0;font-family:sans-serif">
<div id="spy" style="position:fixed;top:0;left:0;background:#fff;border:1px solid #000;padding:2px 6px;z-index:999">scrollY: 0</div>
<script>
const spy = document.getElementById('spy');
const upd = () => { spy.textContent = 'scrollY: ' + Math.round(scrollY); };
addEventListener('scroll', upd, { passive: true });
</script>
<div style="padding-top:32px">
<label><input type="checkbox" id="cb1" onchange="document.getElementById('cb-out').textContent='checkbox-state:'+this.checked"> checkbox-one</label>
<div id="cb-out">checkbox-state:false</div>
<details id="det1" ontoggle="document.getElementById('det-out').textContent='details-state:'+(this.open?'open':'closed')"><summary>expand-me</summary><p>inside content</p></details>
<div id="det-out">details-state:closed</div>
<input id="field" value="initial-value" style="display:block;margin-top:8px">
<div id="bottom-marker" style="color:#888">BOTTOM_MARKER_7c21</div>
${Array.from({ length: 40 }, (_, i) => `<p style="min-height:80px;margin:0">line ${i} ${'content '.repeat(10)}</p>`).join('\n')}
</div>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(18765, '127.0.0.1', r));
const URL = 'http://127.0.0.1:18765/';

// ---- launch Chrome isolated -----------------------------------------------------
const chromeCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = chromeCandidates.find((p) => existsSync(p));
if (!chromePath) { console.log('FAIL  no Chrome/Edge binary found'); process.exit(1); }
const chromeDir = mkdtempSync(join(tmpdir(), 'cu-e2e-chrome-'));
const chrome = spawn(chromePath, [
  `--user-data-dir=${chromeDir}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,900', URL,
], { stdio: 'ignore' });
console.log(`launched ${chromePath.split('/').pop()} pid=${chrome.pid}`);

// ---- launch Notepad --------------------------------------------------------------
const notepad = spawn('notepad.exe', [], { stdio: 'ignore' });

// ---- tools harness ----------------------------------------------------------------
const ctx = { get: () => null, tools: { register() {} }, effect() {} };
const session = new ComputerUseSession();
const tools = Object.fromEntries(buildTools(ctx, session, {
  askBeforeActions: false,
  includeScreenshot: true,
  fx: { overlay: false, screenshot: false },
}).map((t) => [t.name, t]));

const waitForWindow = async (pid, timeoutMs = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const listed = await invokePowerShell({ action: 'list_apps' });
      const hit = (listed.apps ?? []).find((a) => Number(a.pid) === pid && (a.title ?? ''));
      if (hit) return hit;
    } catch { /* kernel warming up */ }
    await sleep(500);
  }
  return null;
};

const snap = async (app) => tools.get_app_state.execute({ app }, {});
const findEl = (pred) => (session.state?.elements ?? []).find(pred);
const spyScrollY = () => {
  const m = String(session.state?.text ?? '').match(/scrollY:\s*(\d+)/);
  return m ? Number(m[1]) : null;
};

const chromeWin = await waitForWindow(chrome.pid);
check('Chrome test window appears', !!chromeWin, chromeWin ? `"${chromeWin.title}"` : 'not found after 20s');
if (!chromeWin) process.exit(1);
const notepadWin = await waitForWindow(notepad.pid, 15000);
check('Notepad window appears', !!notepadWin, notepadWin ? `"${notepadWin.title}"` : 'not found');

// ================= CHROME =================
const C = String(chrome.pid);
let st = await snap(C);
check('get_app_state(Chrome) initial', st.window != null, `tree=${st.treeText.length} chars`);
check('page initial scrollY=0', spyScrollY() === 0, `scrollY=${spyScrollY()}`);
check('checkbox state initially false', /checkbox-state:false/.test(st.treeText ?? ''));

// --- perform_secondary_action: Toggle (checkbox) -----------------------------
const cb = findEl((e) => /checkbox-one|复选框/.test(String(e.name ?? '')));
check('checkbox element in tree', !!cb, cb ? `idx=${cb.index}` : 'not found');
if (cb) {
  const r1 = await tools.perform_secondary_action.execute({ app: C, element_index: cb.index, action: 'Toggle' }, {});
  check('secondary Toggle ok', r1.ok === true, `via=${r1.via} err=${r1.error ?? ''}`);
  st = await snap(C);
  check('checkbox state flips to true', /checkbox-state:true/.test(st.treeText ?? ''));
}

// --- perform_secondary_action: ExpandCollapse (<details>) ---------------------
const det = findEl((e) => (e.patterns ?? []).some((p) => /ExpandCollapse/i.test(p)));
check('details element with ExpandCollapsePattern', !!det, det ? `idx=${det.index}` : 'not found');
if (det) {
  const r2 = await tools.perform_secondary_action.execute({ app: C, element_index: det.index, action: 'ExpandCollapse' }, {});
  check('secondary ExpandCollapse ok', r2.ok === true, `via=${r2.via} err=${r2.error ?? ''}`);
  st = await snap(C);
  check('details state flips to open', /details-state:open/.test(st.treeText ?? ''));
}

// --- scroll: page semantics ----------------------------------------------------
const b = st.window.bounds;
const cx = Math.round(b.width / 2), cy = Math.round(b.height / 2);
const sc1 = await tools.scroll.execute({ app: C, x: cx, y: cy, direction: 'down', pages: 1 }, {});
check('scroll down pages=1 ok', sc1.ok === true, `via=${sc1.via}`);
await sleep(500);
st = await snap(C);
const y1 = spyScrollY();
check('page scroll moved content substantially', y1 != null && y1 >= 200, `scrollY=${y1} (1 page ≈ 12 notches)`);

const sc2 = await tools.scroll.execute({ app: C, x: cx, y: cy, direction: 'up', pages: 1 }, {});
await sleep(500);
st = await snap(C);
const y2 = spyScrollY();
check('scroll up returns toward top', y2 != null && y2 < y1 - 100, `scrollY=${y2} (was ${y1})`);

const sc3 = await tools.scroll.execute({ app: C, x: cx, y: cy, direction: 'down', pages: 0.5 }, {});
await sleep(500);
st = await snap(C);
const y3 = spyScrollY();
check('fractional pages scroll works', y3 != null && y3 > y2 && y3 < y1, `scrollY=${y3} (0.5 pages)`);

// --- type_text / set_value / select_text on the input --------------------------
st = await snap(C);
const field = findEl((e) => /initial-value/.test(String(e.name ?? e.value ?? '')) && /edit/i.test(String(e.role ?? '')));
check('input field with initial-value', !!field, field ? `idx=${field.index}` : 'not found');
if (field) {
  const t1 = await tools.type_text.execute({ app: C, element_index: field.index, text: 'typed-123' }, {});
  check('type_text ok', t1.ok === true, `via=${t1.via}`);
  st = await snap(C);
  check('typed value visible in tree', /typed-123/.test(st.treeText ?? ''));

  const sv = await tools.set_value.execute({ app: C, element_index: field.index, value: 'set-456' }, {});
  check('set_value ok', sv.ok === true, `via=${sv.via} err=${sv.error ?? ''}`);
  st = await snap(C);
  check('set_value reflected in tree', /set-456/.test(st.treeText ?? ''));

  const sel = await tools.select_text.execute({ app: C, element_index: field.index, text: 'set-456' }, {});
  check('select_text ok', sel.ok === true, `via=${sel.via} note=${sel.note ?? ''}`);
}

// ================= NOTEPAD =================
if (notepadWin) {
  const N = String(notepad.pid);
  st = await snap(N);
  const edit = findEl((e) => /edit|document/i.test(String(e.role ?? e.controlType ?? '')));
  check('Notepad edit element', !!edit, edit ? `idx=${edit.index}` : 'not found');
  if (edit) {
    const t2 = await tools.type_text.execute({ app: N, element_index: edit.index, text: 'dsh-e2e alpha 123456' }, {});
    check('Notepad type_text ok', t2.ok === true, `via=${t2.via}`);
    st = await snap(N);
    check('Notepad text present', /dsh-e2e/.test(st.treeText ?? ''));

    const sel2 = await tools.select_text.execute({ app: N, element_index: edit.index, text: 'alpha' }, {});
    check('Notepad select_text ok', sel2.ok === true, `via=${sel2.via} note=${sel2.note ?? ''}`);
    if (sel2.ok === true) {
      st = await snap(N);
      await tools.press_key.execute({ app: N, key: 'Delete' }, {});
      st = await snap(N);
      check('Delete removes the selection', !/alpha/.test(st.treeText ?? '') && /dsh-e2e/.test(st.treeText ?? ''));
    }

    const sv2 = await tools.set_value.execute({ app: N, element_index: edit.index, value: 'final-set-789' }, {});
    check('Notepad set_value ok', sv2.ok === true, `via=${sv2.via} err=${sv2.error ?? ''}`);
    st = await snap(N);
    check('Notepad set_value reflected', /final-set-789/.test(st.treeText ?? ''));

    const pk = await tools.press_key.execute({ app: N, key: 'ctrl+a' }, {});
    check('Notepad ctrl+a ok', pk.ok === true, `events=${pk.events}`);
    st = await snap(N);
    const t3 = await tools.type_text.execute({ app: N, element_index: edit.index, text: 'z' }, {});
    st = await snap(N);
    check('select-all + retype replaces everything', /final-set/.test(st.treeText ?? '') === false && t3.ok === true);

    // --- drag: title bar move (down then back) ------------------------------
    const nb = st.window.bounds;
    const dx = Math.round(nb.width / 2), dyTop = 10;
    const d1 = await tools.drag.execute({ app: N, from_x: dx, from_y: dyTop, to_x: dx, to_y: dyTop + 40 }, {});
    await sleep(300);
    st = await snap(N);
    const moved = Math.abs(st.window.bounds.y - nb.y);
    check('drag moves the window', d1.ok === true && moved > 25, `deltaY=${moved} (bounds ${nb.y} -> ${st.window.bounds.y})`);
    await tools.drag.execute({ app: N, from_x: dx, from_y: dyTop + 40, to_x: dx, to_y: dyTop }, {});
    await sleep(300);
    st = await snap(N);
    check('drag back restores position', Math.abs(st.window.bounds.y - nb.y) <= 8, `bounds.y=${st.window.bounds.y} (was ${nb.y})`);
  }
}

// ---- cleanup ----------------------------------------------------------------------
try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
try { execFileSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
server.close();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
