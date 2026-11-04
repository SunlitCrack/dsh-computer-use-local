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

/** The reply the scripted kernel will send for the next action. */
let nextReply = { ok: true, via: 'coordinate', x: 0, y: 0 };
const mock = installPowerShellMock({
  onRequest(request) {
    // Answer every action the tests drive (click/scroll/drag); an unanswered
    // request would sit until the 45s kernel timeout.
    if (request.proc.kind === 'kernel' && request.payload.action) {
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

test('scroll does not shift the recorded point: its receipt is already screen space', async () => {
  // P4 only converted the CLICK receipts to window-relative pixels; scroll and
  // drag still return the screen point. Converting them too moved the recorded
  // landing point by one window origin in the opposite direction.
  const session = fixtureSession();
  nextReply = { ok: true, via: 'mouse wheel', direction: 'down', pages: 1, x: 520, y: 720 };
  const tools = buildFixtureTools(session);
  const value = await tools.scroll.execute(
    { app: 'fixture', direction: 'down', pages: 1, x: 520, y: 720 },
    { agent: {}, callId: 'test' },
  );
  assertSchema(tools.scroll, value, 'scroll');
  assert.deepEqual(session.lastScreenPoint, { x: 520, y: 720 },
    'a screen-space receipt must be recorded as-is');
  assert.equal(session.lastAction.x, 520 - WINDOW.x, 'screenshot point = screen - origin');
  assert.equal(session.lastAction.y, 720 - WINDOW.y, 'screenshot point = screen - origin');
});

test('drag does not shift the recorded point either', async () => {
  const session = fixtureSession();
  nextReply = { ok: true, via: 'SendInput drag', x: 700, y: 800 };
  const tools = buildFixtureTools(session);
  const value = await tools.drag.execute(
    { app: 'fixture', from_x: 300, from_y: 400, to_x: 700, to_y: 800 },
    { agent: {}, callId: 'test' },
  );
  assertSchema(tools.drag, value, 'drag');
  assert.deepEqual(session.lastScreenPoint, { x: 700, y: 800 },
    'a screen-space receipt must be recorded as-is');
});

test('the FAILED receipt branch renders when a result carries ok:false', async () => {
  // ps1.js rejects ok:false before it reaches render, so this branch is not
  // reachable through execute() today. It is still the correct rendering for any
  // future caller that hands render a refused result, so pin its text.
  const { text } = await (async () => {
    const tools = buildFixtureTools(fixtureSession());
    const rendered = tools.click.output.render({}, {
      ok: false, via: 'element', x: 1, y: 2, error: 'element is disabled',
      observationRequired: true,
    }).map((b) => b.text ?? '').join('');
    return { text: rendered };
  })();
  assert.match(text, /Click FAILED/, `a refused result must not read as a click, got: ${text}`);
  assert.match(text, /element is disabled/, 'the error must be surfaced');
});

// ---------------------------------------------------------------- check_screen_change (P21)
//
// The gate shipped with two defects that no assertion caught, because nothing
// validated this tool's output at all:
//   - execute() set `score: undefined` on the no-baseline path, and an own
//     enumerable undefined property makes the harness snapshot the WHOLE value as
//     undefined -> `tool "check_screen_change" returned invalid output`;
//   - the failed-probe branch returned `window: null` against `{type:'object'}`.
// Both are pinned below by driving the real execute() through the kernel mock and
// validating with the host's own validator.

const PROBE_W = 160;
const PROBE_H = 90;

/** A probe reply: a solid 160x90 frame (the production default), base64 rgb24. */
function probeReply(fill = 120, { split = false } = {}) {
  const bytes = Buffer.alloc(PROBE_W * PROBE_H * 3, fill);
  // `split` paints the left half a different tone, which is a STRUCTURAL change:
  // some cells move, others do not, so the per-cell delta has dispersion. A plain
  // fill is a UNIFORM change (every cell moves equally, sd = 0).
  if (split) {
    // A small centred panel, not a half-and-half split: a half/half split is two
    // large regions each shifting uniformly, which the gate correctly reads as a
    // pair of dominant transforms. A panel is the shape that actually invalidates
    // a tree, and it is the case design 5 missed.
    //
    // Size matters for the threshold lock: at PROBE_W/3 the panel produces ~264
    // deviating cells, which clears BOTH the calibrated default (8) and the stale
    // 40, so it cannot detect the drift. 14x7 yields 24 cells — inside the 8..39
    // band, so only the correct default passes.
    const pw = split === 'tiny' ? 14 : Math.floor(PROBE_W / 3);
    const ph = split === 'tiny' ? 7 : Math.floor(PROBE_H / 3);
    const x0 = Math.floor((PROBE_W - pw) / 2);
    const y0 = Math.floor((PROBE_H - ph) / 2);
    for (let y = y0; y < y0 + ph; y += 1) {
      for (let x = x0; x < x0 + pw; x += 1) {
        const i = (y * PROBE_W + x) * 3;
        bytes[i] = 20; bytes[i + 1] = 20; bytes[i + 2] = 20;
      }
    }
  }
  return {
    ok: true,
    width: PROBE_W,
    height: PROBE_H,
    hwnd: 4242,
    window: { pid: 99, processName: 'fixture', path: '' },
    foreground: true,
    rgb: bytes.toString('base64'),
  };
}

function gateTools() {
  const tools = buildTools({ get: () => undefined }, fixtureSession(), {
    askBeforeActions: false,
    includeScreenshot: false,
    fx: { overlay: false, screenshot: false },
    observeGate: { threshold: 39, width: PROBE_W, height: PROBE_H },
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

test('check_screen_change: the FIRST call passes output.schema despite having no baseline', async () => {
  nextReply = probeReply();
  const tools = gateTools();
  const value = await tools.check_screen_change.execute(
    { app: 'fixture' }, { agent: {}, callId: 'test' },
  );
  assert.equal(value.ok, true);
  assert.equal(value.changed, true, 'no baseline must read as changed');
  assert.equal(typeof value.score, 'number', 'score must be a number, never undefined');
  assert.ok(value.window && typeof value.window === 'object', 'window must be an object, never null');
  assertSchema(tools.check_screen_change, value, 'check_screen_change (first call)');
});

test('check_screen_change: a second identical probe reports unchanged and still validates', async () => {
  nextReply = probeReply();
  const tools = gateTools();
  const call = () => tools.check_screen_change.execute({ app: 'fixture' }, { agent: {}, callId: 'test' });
  const first = await call();
  const second = await call();
  assert.equal(first.changed, true, 'the establishing call has no baseline');
  assert.equal(second.changed, false, 'an identical frame must read as unchanged');
  assert.equal(second.reason, 'uniform-change');
  assertSchema(tools.check_screen_change, second, 'check_screen_change (second call)');
});

test('check_screen_change: a structural change reports changed with a finite score', async () => {
  // Must be a STRUCTURAL change: a uniform brightness shift (120 -> 200) leaves
  // every element where it was, so the fifth design deliberately reports it as
  // unchanged and the tree stays valid. Here the second frame has a different
  // layout, so the verdict must be "changed".
  nextReply = probeReply(120);
  const tools = gateTools();
  const call = () => tools.check_screen_change.execute({ app: 'fixture' }, { agent: {}, callId: 'test' });
  await call();
  nextReply = probeReply(200, { split: true });
  const second = await call();
  assert.equal(second.changed, true, 'a structural change must read as changed');
  assert.ok(Number.isFinite(second.score) && second.score > 0, `expected a positive score, got ${second.score}`);
  assertSchema(tools.check_screen_change, second, 'check_screen_change (changed)');
});

test('check_screen_change: a uniform brightness shift keeps the tree valid', async () => {
  // The other half of the contract: a modal dim or night-mode shift moves no
  // element, so re-observing would return the same tree and cost ~800 ms for
  // nothing. Reporting unchanged here is the point of the feature.
  nextReply = probeReply(120);
  const tools = gateTools();
  const call = () => tools.check_screen_change.execute({ app: 'fixture' }, { agent: {}, callId: 'test' });
  await call();
  nextReply = probeReply(200);
  const second = await call();
  assert.equal(second.changed, false, 'a uniform brightness shift must not force a re-observation');
  assert.equal(second.reason, 'uniform-change');
  assertSchema(tools.check_screen_change, second, 'check_screen_change (uniform)');
});











// --------------------------------------------------- observe-gate decision rule
//
// Pins the FINAL metric. Seven designs each passed their own tests while being
// wrong; every one summarised the frame with a number that some class of change
// could defeat. What finally works is two questions asked in order:
//   1. Did a cell change at FULL CONTRAST? (fine text, code diffs, terminals —
//      sparse by nature, so connectivity cannot see them)
//   2. Otherwise, do the deviating cells form a REGION? (panels, sidebars, dims)
// and one deliberate non-question: there is no peak-magnitude floor, because that
// rejected low-contrast real changes on dark themes.

import { signature, shouldReobserve, changeStats, decide } from '../lib/observe-gate.js';

const GW = 160;
const GH = 90;
const CELL = (x, y) => Math.floor(y / (GH / 36)) * 64 + Math.floor(x / (GW / 64));

function frame(fn) {
  const buf = Buffer.alloc(GW * GH * 3);
  for (let y = 0; y < GH; y += 1) {
    for (let x = 0; x < GW; x += 1) {
      const [r, g, b] = fn(x, y);
      const i = (y * GW + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
  return buf;
}

const flat = (v) => frame(() => [v, v, v]);

/** Base tone dimmed by `dim`, with a centred panel painted at `panelLevel`. */
function maskPlusPanel(dim, pw, ph, panelLevel) {
  const cx = (GW - pw) / 2;
  const cy = (GH - ph) / 2;
  return frame((x, y) => {
    const inPanel = x >= cx && x < cx + pw && y >= cy && y < cy + ph;
    const v = inPanel ? panelLevel : 250 - dim;
    return [v, v, v];
  });
}

/** White frame where the first `cells` grid cells become grey `level`. */
const region = (cells, level) => frame((x, y) => (CELL(x, y) < cells ? [level, level, level] : [250, 250, 250]));

/** Deterministic pseudo-random noise frame. */
function noiseFrame(seed, amplitude) {
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return frame(() => {
    const v = Math.max(0, Math.min(255, 128 + Math.floor(next() * 2 * amplitude - amplitude)));
    return [v, v, v];
  });
}

function verdict(a, b, threshold) {
  const stats = changeStats(signature(a, GW, GH), signature(b, GW, GH));
  return { ...shouldReobserve(signature(a, GW, GH), b, GW, GH, threshold), stats };
}

test('observe-gate: identical frame is unchanged and scores exactly zero', () => {
  const r = verdict(flat(240), flat(240));
  assert.equal(r.changed, false);
  assert.equal(r.score, 0);
  assert.equal(r.stats.devCount, 0);
});

test('observe-gate: cursor drift and antialiasing jitter stay below the count threshold', () => {
  const cursorA = frame((x, y) => (x >= 80 && x < 82 && y >= 44 && y < 46) ? [0, 0, 0] : [240, 240, 240]);
  const cursorB = frame((x, y) => (x >= 83 && x < 85 && y >= 44 && y < 46) ? [0, 0, 0] : [240, 240, 240]);
  const rc = verdict(cursorA, cursorB);
  assert.equal(rc.changed, false, 'a small cursor move must not trigger an observation');
  assert.ok(rc.stats.devCount < 8, `a cursor must stay under the cell threshold (got ${rc.stats.devCount})`);

  const textA = frame((x, y) => (y >= 40 && y < 44 && x >= 20 && x < 140 && x % 3 === 0) ? [60, 60, 60] : [250, 250, 250]);
  const textB = frame((x, y) => (y >= 40 && y < 44 && x >= 20 && x < 140 && x % 3 === 0) ? [62, 62, 62] : [250, 250, 250]);
  assert.equal(verdict(textA, textB).changed, false, 'a 2-level text shift must not trigger an observation');
});

test('observe-gate: a uniform change reads unchanged at EVERY amplitude (no cliff)', () => {
  for (const drop of [10, 25, 40, 45, 50, 55, 59, 60, 80, 120, 200]) {
    const r = verdict(flat(250), flat(250 - drop));
    assert.equal(r.changed, false, `a uniform ${drop}-level change must read unchanged`);
    assert.equal(r.stats.devCount, 0, `a uniform ${drop}-level change has no deviating cells`);
  }
});

test('observe-gate: a pale hover tint stays below the floor', () => {
  const base = flat(250);
  const hover = frame((x, y) => (x >= 40 && x < 120 && y >= 30 && y < 50) ? [230, 240, 255] : [250, 250, 250]);
  assert.equal(verdict(base, hover).changed, false, 'a hover tint must not trigger an observation');
});

test('observe-gate: mask plus a small dialog IS a change', () => {
  // The case that defeated design 5 (sd 4.42). A dialog has opened, the tree is stale.
  for (const [pw, ph] of [[16, 10], [22, 12], [26, 14], [32, 18], [40, 22], [50, 28]]) {
    const r = verdict(flat(250), maskPlusPanel(45, pw, ph, 255));
    assert.equal(r.changed, true, `mask + ${pw}x${ph} dialog must read as changed`);
  }
});



test('observe-gate: a sidebar is detected regardless of grid phase', () => {
  for (const edge of [40, 41, 43, 45, 50]) {
    const shot = frame((x, y) => (x < edge ? [150, 150, 150] : [250, 250, 250]));
    assert.equal(verdict(flat(250), shot).changed, true, `a sidebar at x=${edge} must read as changed`);
  }
});

test('observe-gate: a content swap between two panes IS a change', () => {
  const before = frame((x, y) => (x < GW / 2 ? [10, 10, 10] : [210, 210, 210]));
  const after = frame((x, y) => (x < GW / 2 ? [210, 210, 210] : [10, 10, 10]));
  assert.equal(verdict(before, after).changed, true, 'a half/half content swap must read as changed');
});

test('observe-gate: a two-tone theme switch IS a change', () => {
  const before = frame((x, y) => ((CELL(x, y) % 2 === 0) ? [30, 30, 30] : [220, 220, 220]));
  const after = frame((x, y) => ((CELL(x, y) % 2 === 0) ? [220, 220, 220] : [30, 30, 30]));
  assert.equal(verdict(before, after).changed, true);
});

test('observe-gate: no magnitude floor — a low-contrast structural change still counts', () => {
  // On a dark theme a 40%-wide panel at V=25 has hundreds of deviating cells but a
  // peak far under 39; a magnitude floor used to reject it.
  const base = flat(60);
  for (const level of [35, 30, 25]) {
    const shot = frame((x, y) => (x < GW * 0.4 ? [level, level, level] : [60, 60, 60]));
    const r = verdict(base, shot);
    assert.ok(r.score < 39, `this case must stay under any plausible floor, got ${r.score}`);
    assert.equal(r.changed, true, `a dark-theme panel at V=${60 - level} must still read as changed`);
  }
});

test('observe-gate: a tiny but high-contrast block is detected (no percentile tail loss)', () => {
  for (const cells of [12, 23, 46]) {
    const r = verdict(flat(250), region(cells, 0));
    assert.equal(r.changed, true, `a ${cells}-cell full-contrast block must read as changed`);
    assert.equal(r.score, 250, 'the peak statistic must see the block at full strength');
  }
});

test('observe-gate: a button highlight and a focus ring are changes (chroma branch)', () => {
  const base = flat(250);
  const button = frame((x, y) => (x >= 60 && x < 100 && y >= 40 && y < 55) ? [0, 120, 215] : [250, 250, 250]);
  assert.equal(verdict(base, button).changed, true);
  const ring = frame((x, y) => (x >= 40 && x < 120 && y >= 30 && y < 32) ? [0, 120, 215] : [250, 250, 250]);
  assert.equal(verdict(base, ring).changed, true);
});

test('observe-gate: a same-brightness hue swap is a change', () => {
  const r = verdict(frame(() => [200, 20, 20]), frame(() => [20, 20, 200]));
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'chroma-change');
});

test('observe-gate: low-amplitude noise stays unchanged', () => {
  const r = verdict(noiseFrame(42, 20), noiseFrame(99, 20));
  assert.equal(r.changed, false, 'low-amplitude noise must not read as a change');
});

test('observe-gate: a malformed frame reads as changed, never as unchanged', () => {
  const sig = signature(flat(240), GW, GH);
  const r = shouldReobserve(sig, Buffer.alloc(3, 50), GW, GH);
  assert.equal(r.changed, true, 'a frame of the wrong size must not be reported as unchanged');
});

test('observe-gate: decide() is driven by statistics, not images', () => {
  assert.equal(decide({ median: 0, devCount: 0, adjacency: 0, maxAbs: 0, maxC: 0 }).changed, false);
  assert.equal(decide({ median: -45, devCount: 0, adjacency: 0, maxAbs: 45, maxC: 0 }).changed, false, 'uniform');
  assert.equal(decide({ median: -45, devCount: 27, adjacency: 50, maxAbs: 45, maxC: 0 }).changed, true, 'mask + small dialog');
  assert.equal(decide({ median: 0, devCount: 4, adjacency: 4, maxAbs: 165, maxC: 0 }).changed, false, 'a cursor: few cells');
  assert.equal(decide({ median: 0, devCount: 500, adjacency: 100, maxAbs: 60, maxC: 0 }).changed, false, 'many scattered low-contrast cells are noise');
  assert.equal(decide({ median: 0, devCount: 500, adjacency: 900, maxAbs: 210, maxC: 0 }).changed, true, 'full-contrast scattered cells are text');
  assert.equal(decide({ median: 0, devCount: 500, adjacency: 900, maxAbs: 60, maxC: 0 }).changed, true, 'a connected region is structural');
  assert.equal(decide({ median: 0, devCount: 0, adjacency: 0, maxAbs: 5, maxC: 80 }).changed, true, 'chroma wins with a tiny peak');
  assert.equal(decide({ median: NaN, devCount: NaN, adjacency: NaN, maxAbs: NaN, maxC: 0 }).changed, true, 'bad numbers must fail open');
});

test('check_screen_change: the production default threshold equals the calibrated cell count', async () => {
  // The regression this locks: `observeGate.threshold` defaulted to 40 in tools.js
  // (left over from when it was a 0..255 brightness floor) while observe-gate.js
  // maps it onto `residualCells`, whose calibrated value is 8. The production bar
  // was 5x higher than every unit test asserted, so the small-dialog cases fixed
  // over three rounds silently read "unchanged" in the real plugin.
  //
  // The fixture must produce a devCount between 8 and 39, or the test passes under
  // BOTH values and locks nothing: a 1/3-frame panel gives 264 cells, which clears
  // 8 and 40 alike. 14x7 gives 24.
  nextReply = probeReply(120);
  const tools = buildTools({ get: () => undefined }, fixtureSession(), {
    askBeforeActions: false,
    includeScreenshot: false,
    fx: { overlay: false, screenshot: false },
    observeGate: { width: PROBE_W, height: PROBE_H },   // no threshold: default only
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await byName.check_screen_change.execute({ app: 'fixture' }, { agent: {}, callId: 'test' });
  nextReply = probeReply(120, { split: 'tiny' });
  const second = await byName.check_screen_change.execute({ app: 'fixture' }, { agent: {}, callId: 'test' });
  assert.equal(second.changed, true,
    'a small panel must read as changed under the DEFAULT threshold; if this fails the '
    + 'production default has drifted above the calibrated cell count');
});

test('observe-gate: the cell count comes from the grid, not the buffer length', () => {
  // The regression this locks: when the signature grew to 4 floats per cell,
  // changeStats still divided the buffer length by 3. That gave 3072 cells instead
  // of 2304, inflated gridH from 36 to 48, read past the end of the array, and
  // skewed the median by 3x (-43.33 instead of -130.00 on a three-band frame).
  // It stayed invisible because the out-of-range reads produced NaN, which the
  // deviation test silently skips, and because median's index still landed inside
  // the real data.
  //
  // A three-band frame pins the arithmetic: the exact median of {0, -100, -200}
  // repeated 768 times each is -100, and devCount is 1548.
  const three = (levels) => frame((x, y) => {
    const band = x < GW / 3 ? 0 : (x < 2 * GW / 3 ? 1 : 2);
    const v = levels[band];
    return [v, v, v];
  });
  const stats = changeStats(signature(three([250, 250, 250]), GW, GH), signature(three([100, 150, 200]), GW, GH));
  assert.equal(stats.devCount, 1548, 'cell count must be 2304, not a buffer-length quotient');
  assert.ok(Math.abs(stats.median - (-100)) < 1, `median must be about -100, got ${stats.median}`);
});





test('observe-gate: sparse text is caught by area+connectivity, not by a magnitude channel', () => {
  // Calibrated against EXPORTED REAL FRAMES from a code-diff view (see the Qoder
  // fixture this project's review produced): desaturated scrolling measures
  // devCount 135-168 (5.9-7.3% of 2304) with connectivity 0.49-0.70 — below the
  // region threshold, above noise.
  //
  // Two earlier attempts used a magnitude channel (darkest pixel, then dark-pixel
  // count) and both failed for structural reasons: real content already has a dark
  // pixel in 98.7% of cells, and the per-cell sample count is too small to make a
  // count meaningful. Area is what separates text from noise.
  //
  // Synthetic patterns do NOT reproduce this: ruled text lines form continuous
  // adjacency (conn 1.67) while real diff text lands on narrow disjoint columns
  // (conn 0.49). The assertions below therefore drive decide() with the measured
  // statistics rather than trying to synthesise the image.
  assert.equal(
    decide({ median: 0, devCount: 168, adjacency: 82, maxAbs: 47, maxC: 0 }).changed,
    true, 'real diff-text scrolling statistics must read as changed',
  );
  assert.equal(
    decide({ median: 0, devCount: 168, adjacency: 82, maxAbs: 47, maxC: 0 }).reason,
    'text-change',
  );
  // Noise with the same connectivity covers far more area and must stay unchanged.
  assert.equal(
    decide({ median: 0, devCount: 443, adjacency: 173, maxAbs: 44, maxC: 0 }).changed,
    false, 'dense low-connectivity noise must not qualify',
  );
});

test('check_screen_change receipt never compares score against threshold', () => {
  // `score` is a peak pixel delta (0-255); `threshold` is a required count of
  // deviating CELLS (0-2304). An earlier receipt read
  //   "score 67.7 vs threshold 8"
  // which looks like 67.7 failed a bar of 8 — two unrelated units printed as a
  // comparison. The receipt must name `deviation` as the gated quantity.
  const tools = buildTools({ get: () => undefined }, fixtureSession(), {
    askBeforeActions: false,
    includeScreenshot: false,
    fx: { overlay: false, screenshot: false },
    observeGate: { width: PROBE_W, height: PROBE_H },
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const value = {
    ok: true, changed: true, score: 67.7, deviation: 168, connectivity: 0.49,
    threshold: 8, reason: 'text-change', elapsedMs: 232, window: {},
  };
  const text = byName.check_screen_change.output.render({}, value)
    .map((block) => block.text ?? '').join('');
  assert.ok(!/vs threshold/.test(text), `the receipt must not print a cross-unit comparison: ${text}`);
  assert.match(text, /168 cells/, `the gated quantity must be named: ${text}`);
  assert.match(text, /needs 8 cells/, `the requirement must be named in the same unit: ${text}`);
  assertSchema(byName.check_screen_change, value, 'check_screen_change receipt');
});
