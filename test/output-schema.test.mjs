// Output-schema conformance for the tools' execute() results.
//
// Why this file exists: nothing in the suite ever validated tool output against
// output.schema, so a kernel reply of `note: null` slipped through and every
// click that reached an element without InvokePattern died at the host with
//   tool "click" returned invalid output: "value.note" must be a string
// (that is what 0.3.2-local.3 fixed). These cases re-drive execute() against a
// scripted kernel and assert the value passes the very validator the host uses.
//
// The kernel here is the real PowerShell boundary mock: tool code, argument
// marshalling, coordinate mapping and schema validation all run for real.
//
// One mock instance serves every case on purpose: installPowerShellMock captures
// spawn at install time and restores it at dispose, so re-installing inside one
// process leaves the previous mock chained as the "original".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { buildTools } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';

const require = createRequire(import.meta.url);
const { installPowerShellMock } = require('./helpers/mock-powershell.cjs');

const WINDOW = { x: 120, y: 120, width: 1800, height: 1240 };

/** A snapshot with one window, one plain pane and one button. */
function fixtureSession() {
  const session = new ComputerUseSession();
  session.state = {
    window: { hwnd: 4242, pid: 99, processName: 'fixture', title: 'Fixture', bounds: WINDOW, foreground: true },
    elements: [
      { index: 0, path: '', role: 'Window', name: 'Fixture', enabled: true, settable: false,
        secondaryActions: [], frame: { x: 0, y: 0, width: 1800, height: 1240 } },
      { index: 1, path: '0.0', role: 'Pane', name: 'Plain', enabled: true, settable: false,
        secondaryActions: [], frame: { x: 200, y: 300, width: 300, height: 200 } },
      { index: 2, path: '0.1', role: 'Button', name: 'Go', enabled: true, settable: false,
        secondaryActions: ['Invoke'], frame: { x: 620, y: 700, width: 80, height: 40 } },
    ],
    elementCount: 3,
  };
  session.stateApp = 'fixture';
  session.modelScale = 1;
  session.markers = [];
  return session;
}

function buildFixtureTools(session) {
  const tools = buildTools({ get: () => undefined }, session, {
    askBeforeActions: false,
    includeScreenshot: false,
    fx: { overlay: false, screenshot: false },
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

function assertSchema(tool, value, label) {
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value');
  assert.deepEqual(violations, [], `${label}: output violates output.schema -> ${JSON.stringify(violations)}`);
}

/** The reply the scripted kernel will send for the next click. */
let nextReply = { ok: true, via: 'coordinate', x: 0, y: 0 };
const mock = installPowerShellMock({
  onRequest(request) {
    if (request.proc.kind === 'kernel' && request.payload.action === 'click') {
      mock.reply(request, nextReply);
    }
  },
});
test.after(() => mock.restore());

/** Run one click against the scripted reply. */
async function runClick({ reply, args, session = fixtureSession() }) {
  nextReply = reply;
  const tools = buildFixtureTools(session);
  const value = await tools.click.execute({ app: 'fixture', ...args }, { agent: {}, callId: 'test' });
  const text = tools.click.output.render({ ...args }, value).map((b) => b.text ?? '').join('');
  return { value, text, session, tool: tools.click };
}

test('click by element_index: a null kernel note must not break the schema', async () => {
  // The regression: the kernel emits note:null on the plain path and the schema
  // types note as string, so the whole call was rejected.
  const { value, text, tool } = await runClick({
    args: { element_index: 1 },
    reply: { ok: true, via: 'coordinate', note: null, x: 350, y: 400 },
  });
  assert.equal(value.ok, true);
  assert.ok(!('note' in value) || typeof value.note === 'string', 'note must be absent or a string');
  assertSchema(tool, value, 'click(element_index)');
  assert.match(text, /Clicked \(element\)/, 'receipt should still name the addressing mode');
});

test('click by x/y: coordinates are reported once when both spaces agree', async () => {
  // modelScale is 1 here, so the screenshot is a 1:1 copy of the window: the
  // kernel's landing point and the caller's point are the same numbers, and the
  // receipt must print them once instead of "window (a,b) = screenshot (a,b)".
  const p = { x: 400, y: 600 };
  const { value, text, tool } = await runClick({
    args: { x: p.x, y: p.y },
    reply: { ok: true, via: 'coordinate', x: p.x, y: p.y },
  });
  assertSchema(tool, value, 'click(x,y)');
  const shown = text.match(/at window \(400, 600\)/g) ?? [];
  assert.equal(shown.length, 1, `expected a single coordinate, got: ${text}`);
  assert.doesNotMatch(text, /screenshot \(400, 600\)/, 'the same point must not be printed twice');
});

test('click by x/y: both spaces are shown when they differ', async () => {
  // A downscaled screenshot makes the two spaces genuinely different; neither
  // may be hidden then.
  const { value, text, tool } = await runClick({
    args: { x: 400, y: 600 },
    reply: { ok: true, via: 'coordinate', x: 402, y: 601 },
  });
  assertSchema(tool, value, 'click(x,y) scaled');
  assert.match(text, /window \(402, 601\)/, `expected the landing point, got: ${text}`);
  assert.match(text, /screenshot \(400, 600\)/, `expected the caller point too, got: ${text}`);
});

test('click by marker: an unsnapped marker reports the raw pixel and neighbours', async () => {
  const session = fixtureSession();
  // Marker in empty space: nothing interactive covers it.
  session.markers = [{ id: 'D6', x: 900, y: 1100 }];
  const { value, text, tool } = await runClick({
    args: { marker: 'D6' },
    session,
    reply: { ok: true, via: 'coordinate', x: 900, y: 1100 },
  });
  assertSchema(tool, value, 'click(marker-raw)');
  assert.equal(value.via, 'marker-raw');
  assert.match(text, /NO SNAPPABLE CONTROL/, 'an unsnapped marker must say so');
});

test('click reports the ACTUAL landing point, so the amber ring sits on it', async () => {
  // The kernel reports x/y in WINDOW-relative pixels; recordAction stores screen
  // pixels and subtracts the window origin itself. Passing the kernel value
  // straight through made the ring land one window-origin away (measured
  // -120,-120 on a window at (120,120)).
  const landed = { x: 350, y: 400 };   // what the kernel says it clicked
  const { session } = await runClick({
    args: { x: 280, y: 480 },
    reply: { ok: true, via: 'coordinate', ...landed },
  });
  assert.deepEqual(
    session.lastScreenPoint,
    { x: landed.x + WINDOW.x, y: landed.y + WINDOW.y },
    'screen point = window point + origin',
  );
  assert.equal(session.lastAction.x, landed.x, 'screenshot point must match where the click landed');
  assert.equal(session.lastAction.y, landed.y, 'screenshot point must match where the click landed');
});

test('a refused click surfaces as an error, never as a silent success', async () => {
  // ps1.js rejects the request when the kernel answers ok:false, so the refusal
  // travels as a thrown error and the tool reports it as a failure rather than
  // rendering "Clicked (...)". Lock that in: a silent ok:false would make a
  // refused action look like a completed one.
  await assert.rejects(
    runClick({
      args: { element_index: 2 },
      reply: { ok: false, via: 'element', x: 0, y: 0, error: 'element is disabled' },
    }),
    /element is disabled/,
  );
});

test('a null required field is not silently deleted', async () => {
  // ok is required by the schema; deleting it would turn a validation failure
  // into "missing required property", which is harder to diagnose.
  const { value } = await runClick({
    args: { element_index: 2 },
    reply: { ok: null, via: 'element', x: 1, y: 2 },
  });
  assert.ok('ok' in value, 'ok must survive the null sweep');
});
