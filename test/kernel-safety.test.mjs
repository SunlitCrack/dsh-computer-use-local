import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const windowsOnly = { skip: process.platform !== 'win32' };
let cases;
before(async () => {
  if (windowsOnly.skip) return;
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./fixtures/kernel-safety.ps1', import.meta.url)),
  ], { windowsHide: true, timeout: 15000 });
  cases = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
});

test('UIA failure never redirects an element action to another HWND', windowsOnly, () => {
  assert.match(cases.binding.error ?? '', /window 101/);
  assert.equal(cases.binding.result, null);
  assert.ok(cases.binding.lookups.length > 1);
  assert.ok(cases.binding.lookups.every((hwnd) => hwnd === 101));
  assert.equal(cases.binding.alternateLookups, 0);
  assert.equal(cases.binding.invokedHwnd, 0);
});

test('transient UIA errors still retry the original window successfully', windowsOnly, () => {
  assert.equal(cases.retry.error, null);
  assert.equal(cases.retry.hwnd, 101);
  assert.deepEqual(cases.retry.lookups, [101, 101, 101]);
});

test('a missing UIA root fails with the target HWND', windowsOnly, () => {
  assert.match(cases.nullRoot.error ?? '', /window 101/);
});

test('a normal left click retains InvokePattern support', windowsOnly, () => {
  const click = cases.clicks.find((entry) => entry.button === 'left' && entry.count === 1);
  assert.equal(click.error, null);
  assert.equal(click.result.via, 'InvokePattern');
  assert.equal(click.invokeCount, 1);
  assert.deepEqual(click.pointerCalls, []);
});

for (const [button, count] of [['right', 1], ['middle', 1], ['left', 2], ['left', 3]]) {
  test(`${button} click x${count} preserves the requested physical mouse events`, windowsOnly, () => {
    const click = cases.clicks.find((entry) => entry.button === button && entry.count === count);
    assert.equal(click.error, null);
    assert.equal(click.invokeCount, 0);
    assert.deepEqual(click.pointerCalls, [{ button, count, x: 50, y: 35 }]);
    assert.equal(click.result.via, 'coordinate');
  });
}

test('failed activation refuses typing before sending input to the foreground app', windowsOnly, () => {
  assert.match(cases.activationRejected.error ?? '', /foreground/);
  assert.equal(cases.activationRejected.attempts, 1);
  assert.equal(cases.activationRejected.typedInto, 0);
});

test('successful activation still types into the requested window', windowsOnly, () => {
  assert.equal(cases.activationAccepted.error, null);
  assert.equal(cases.activationAccepted.result.ok, true);
  assert.equal(cases.activationAccepted.typedInto, 101);
});

test('observation fails when requested activation fails', windowsOnly, () => {
  assert.match(cases.observationRejected.error ?? '', /foreground/);
  assert.equal(cases.observationRejected.result, null);
});

test('the explicit observation activation opt-out still works', windowsOnly, () => {
  assert.equal(cases.observeWithoutActivation.error, null);
  assert.equal(cases.observeWithoutActivation.result.ok, true);
  assert.equal(cases.observeWithoutActivation.result.window.foreground, false);
});

// P3's recovery path. Before Find-ElementByIdentity became loadable in the
// fixture, no case could reach it: every other case passes path='' with no
// identity, so the whole feature was untested.
test('a drifted path falls back to the element identity and says so', windowsOnly, () => {
  assert.equal(cases.identityRecovery.error, null);
  assert.equal(cases.identityRecovery.result.ok, true);
  assert.match(cases.identityRecovery.result.note ?? '', /identity-recovered/,
    'the caller must be told the click moved to a re-found element');
});

test('an identity that matches nothing fails instead of clicking a neighbour', windowsOnly, () => {
  // The dangerous outcome is acting on whatever now sits at the stale path and
  // reporting success; P3 exists to make that impossible.
  assert.match(cases.identityMissing.error ?? '', /no longer resolves/);
  assert.equal(cases.identityMissing.result, null);
  assert.deepEqual(cases.identityMissing.pointerCalls, [], 'nothing may be clicked');
});

// The case P3 was actually written for: the path RESOLVES, onto a different
// element. Distinct from the unresolvable path above -- different branch
// (uia.ps1:1628 vs :1624) and a different message. Before this case existed the
// drift branch had no coverage at all: disabling it left the suite green.
test('a path that now resolves to a different element is recovered by identity', windowsOnly, () => {
  assert.equal(cases.identityDrift.error, null);
  assert.equal(cases.identityDrift.result.ok, true);
  assert.match(cases.identityDrift.result.note ?? '', /identity-recovered-from-drift/,
    'drift must be reported distinctly from a plain re-find');
});

test('a drifted path with nothing to recover fails and clicks nothing', windowsOnly, () => {
  assert.match(cases.identityDriftUnrecoverable.error ?? '', /now resolves to a different element/);
  assert.match(cases.identityDriftUnrecoverable.error ?? '', /someOtherButton/,
    'the error must name the element it actually found');
  assert.equal(cases.identityDriftUnrecoverable.result, null);
  assert.deepEqual(cases.identityDriftUnrecoverable.pointerCalls, [], 'nothing may be clicked');
});

// The fixture keeps the kernel away from real input by not loading the input
// types at all. That is an accident of loading only function bodies, so it is
// asserted -- and these cases are what make the assertion load-bearing: remove
// the guard and they fail rather than the suite staying green while Invoke-Action
// types into whatever window is focused.
test('the fixture asserts it cannot reach real input', windowsOnly, () => {
  assert.equal(cases.isolation.status, 'ok');
  assert.ok(cases.isolation.forbiddenTypes.includes('CuInput'), 'CuInput must be banned');
  assert.ok(cases.isolation.forbiddenTypes.includes('System.Windows.Forms.SendKeys'), 'SendKeys must be banned');
  assert.ok(cases.isolation.forbiddenMembers.includes('SetCursorPos'),
    'the real CuNative moves the pointer through SetCursorPos');
  assert.ok(cases.isolation.forbiddenMembers.includes('keybd_event'),
    'the real CuNative presses keys through keybd_event');
  // A detector that cannot fire proves nothing; confirm it sees a member that is
  // definitely on the mock.
  assert.equal(cases.isolation.detectsPresentMember, true,
    'the member scan must be capable of finding a present member');
  // And it must actually RUN per case. A load-time-only check is outrun by any
  // Add-Type added later in the file, which is how the first version of this
  // guard passed while the kernel typed into the real desktop.
  assert.ok(cases.isolation.runs > 1,
    `the guard must run before every case; it ran ${cases.isolation.runs} time(s)`);
});

// HasChildren decides whether the mock claims children for a node. Without it
// every node answers "yes, children", so the kernel's leaf-at-depth-limit check
// is always true and truncatedByDepth becomes meaningless.
test('a node that reports no children is not counted as truncated', windowsOnly, () => {
  assert.equal(cases.leafNode.truncatedByDepth, false,
    'a leaf at the depth limit has nothing below it to lose');
  assert.equal(cases.branchNode.truncatedByDepth, true,
    'a node WITH children at the depth limit is genuinely truncated');
});
