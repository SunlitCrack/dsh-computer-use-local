// Temporary buildTools-level E2E for the two integrated annotation features:
//   A) grid markers: get_app_state draws a numbered crosshair grid on the
//      screenshot and returns markers; click({marker}) maps the id back to
//      capture pixels and snaps to the containing interactive element center.
//   B) lastPoint: get_app_state draws an amber ring at the last action landing
//      point and appends the legend to treeText.
// Target: Calculator (ApplicationFrameHost + title 计算器/Calculator), standard
// mode. get_state does NOT activate the window, so the script activates first —
// an occluding window would otherwise be captured instead.
import { execFileSync } from 'node:child_process';
import { invokePowerShell } from '../lib/ps1.js';
import { buildTools } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- find Calculator -----------------------------------------------------------
const listed = await invokePowerShell({ action: 'list_apps' });
const hit = (listed.apps ?? []).find((a) =>
  (a.app === 'ApplicationFrameHost' || a.processName === 'ApplicationFrameHost')
  && /计算器|Calculator/i.test(String(a.title ?? '')));
if (!hit) {
  console.log('FAIL  no Calculator window found — open Calculator (standard mode) and re-run');
  process.exit(1);
}
console.log(`target: ${hit.app} (pid ${hit.pid}) "${hit.title}"`);

// Bring the target to the foreground (Alt trick, same as _tmp-grid-demo.mjs).
const PS_ACTIVATE = `
$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$k = Add-Type -MemberDefinition $sig -Name CuItVerifyActivate -Namespace Win32 -PassThru
$proc = Get-Process -Id ([int]$env:G_PID) -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output 'activated=0'; exit 0 }
$h = $proc.MainWindowHandle
[void]$k::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void]$k::ShowWindow($h, 9)
[void]$k::SetForegroundWindow($h)
[void]$k::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
if ($k::GetForegroundWindow() -eq $h) { Write-Output 'activated=1' } else { Write-Output 'activated=0' }
`;
try {
  const act = execFileSync('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_ACTIVATE],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, G_PID: String(hit.pid) } });
  if (!String(act).includes('activated=1')) console.log('WARNING: activation failed — capture may show an occluding window');
} catch (e) {
  console.log('WARNING: activation step errored (continuing):', String(e.message).slice(0, 120));
}

// --- buildTools with a real session; overlay motion off for determinism --------
const ctx = { get: () => null, tools: { register() {} }, effect() {} };
const session = new ComputerUseSession();
const tools = Object.fromEntries(buildTools(ctx, session, {
  askBeforeActions: false,
  includeScreenshot: true,
  fx: { overlay: false, screenshot: false },
}).map((t) => [t.name, t]));
const app = String(hit.pid);

// Clear the display first. Actions are observation-gated, so take a snapshot
// before Escape and then observe again for the actual marker test.
try {
  await tools.get_app_state.execute({ app }, {});
  await tools.press_key.execute({ app, key: 'Escape' }, {});
} catch { /* best-effort */ }

// --- A) get_app_state: markers --------------------------------------------------
const st = await tools.get_app_state.execute({ app }, {});
const markers = session.markers;
check('get_app_state yields grid markers in session', Array.isArray(markers) && markers.length > 0,
  `count=${markers?.length}`);
check('marker count within the 100 limit', Array.isArray(markers) && markers.length <= 100,
  `count=${markers?.length}`);
const ids = new Set((markers ?? []).map((m) => m.id));
check('marker ids are unique', ids.size === (markers ?? []).length, `unique=${ids.size}`);
const bounds = st.window?.bounds;
check('marker coordinates are in-window capture-pixel ints',
  (markers ?? []).every((m) => Number.isInteger(m.x) && Number.isInteger(m.y)
    && m.x >= 0 && m.y >= 0 && m.x <= bounds.width && m.y <= bounds.height),
  `window=${bounds?.width}x${bounds?.height}`);
check('treeText carries the Grid legend', st.treeText.includes('Grid: numbered crosshairs are drawn on the screenshot'));

// --- pick a marker inside num3Button -------------------------------------------
const num3 = (session.state?.elements ?? []).find((e) => e.automationId === 'num3Button');
check('num3Button present in the snapshot', !!num3,
  num3 ? `frame=[${num3.frame.x},${num3.frame.y},${num3.frame.width},${num3.frame.height}]` : 'not found');
const f = num3?.frame;
const inButton = (markers ?? []).filter((m) => f
  && m.x >= f.x && m.x <= f.x + f.width && m.y >= f.y && m.y <= f.y + f.height);
check('num3Button frame contains at least one marker (grid or E-topped)',
  inButton.length > 0, `ids=${inButton.map((m) => m.id).join(',')}`);
if (!inButton.length || !num3) process.exit(1);
const markerId = inButton[0].id;
console.log(`clicking marker ${markerId} at (${inButton[0].x}, ${inButton[0].y}) inside num3Button`);

// --- click({marker}) -------------------------------------------------------------
const clickRes = await tools.click.execute({ app, marker: markerId }, {});
check('click({marker}) succeeds', clickRes.ok === true,
  `via=${clickRes.via} at=(${clickRes.x},${clickRes.y}) note=${clickRes.note}`);
check('click note reports the UIA snap to num3Button', /snapped to .*num3Button.* center/.test(String(clickRes.note ?? '')),
  String(clickRes.note));
const expectX = bounds.x + Math.round(f.x + f.width / 2);
const expectY = bounds.y + Math.round(f.y + f.height / 2);
check('click landed at the snapped element center (screen px)',
  Math.abs(clickRes.x - expectX) <= 2 && Math.abs(clickRes.y - expectY) <= 2,
  `got=(${clickRes.x},${clickRes.y}) expected≈(${expectX},${expectY})`);

// --- B) observe again: display + amber ring --------------------------------------
const st2 = await tools.get_app_state.execute({ app }, {});
const dm = st2.treeText.match(/显示为 (\d+)/) || st2.treeText.match(/Display is (\d+)/);
check('calculator display shows the clicked digit (3)', dm != null && /3/.test(dm[1]),
  `display=${dm ? dm[1] : '?'}`);
check('treeText carries the Amber legend after the action',
  st2.treeText.includes('Amber ring: where the last action landed'));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
