import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { buildTools, stopOverlay } from '../lib/tools.js';
import { ComputerUseSession } from '../lib/session.js';
import { invokePowerShell, stopPowerShellKernel } from '../lib/ps1.js';
import { setAuditEnabled } from '../lib/audit.js';
import { installPowerShellMock } from './helpers/mock-powershell.cjs';

// node --test isolates this file in its own process. Keep the mock installed
// through teardown so delayed cursor-restore callbacks cannot touch the desktop.
const backend = installPowerShellMock();
setAuditEnabled(false);
afterEach(async () => {
  stopOverlay();
  stopPowerShellKernel();
  await nextTurn();
  backend.clear();
});

const snapshot = {
  ok: true,
  window: { hwnd: 101, pid: 42, processName: 'fixture', title: 'fixture', bounds: { x: 0, y: 0, width: 800, height: 600 }, foreground: true },
  elements: [{ index: 0, path: '', frame: { x: 10, y: 20, width: 80, height: 30 } }],
  elementCount: 1,
  treeText: '0 Edit fixture frame=[10,20,80,30]',
};

function makeTools(overlay = false) {
  const session = new ComputerUseSession();
  session.store(structuredClone(snapshot), 'fixture');
  const tools = buildTools({ get() {} }, session, { askBeforeActions: false, includeScreenshot: false, fx: { overlay } });
  return { session, tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])) };
}

const settled = (promise) => promise.then((result) => ({ result }), (error) => ({ error }));
const isKernelRequest = (request) => request.proc.kind === 'kernel';
function successfulReply(request) {
  if (request.payload.action === 'get_state') return structuredClone(snapshot);
  if (request.payload.action === 'list_apps') return { ok: true, apps: [], count: 0 };
  return { ok: true, via: 'test backend' };
}

const calls = [
  ['list_apps', {}],
  ['get_app_state', { app: 'fixture' }],
  ['click', { app: 'fixture', element_index: 0 }],
  ['perform_secondary_action', { app: 'fixture', element_index: 0, action: 'Invoke' }],
  ['set_value', { app: 'fixture', element_index: 0, value: 'sample' }],
  ['select_text', { app: 'fixture', element_index: 0, text: 'sample' }],
  ['scroll', { app: 'fixture', direction: 'down', pages: 1 }],
  ['drag', { app: 'fixture', from_x: 10, from_y: 20, to_x: 30, to_y: 40 }],
  ['press_key', { app: 'fixture', key: 'Return' }],
  ['type_text', { app: 'fixture', text: 'sample' }],
];

for (const [name, args] of calls) {
  test(`${name} cancels its in-flight kernel request`, async () => {
    const { tools, session } = makeTools();
    const controller = new AbortController();
    const pending = settled(tools[name].execute(args, { signal: controller.signal }));
    const request = await backend.waitForRequest(isKernelRequest);
    controller.abort(new Error('user cancelled'));
    await nextTurn();
    // On the unfixed implementation this delivers a successful late reply,
    // making the regression fail immediately instead of waiting for 45 seconds.
    backend.reply(request, successfulReply(request));
    const outcome = await pending;
    assert.match(outcome.error?.message ?? '', /aborted/);
    assert.equal(request.proc.killed, true);
    assert.equal(Object.hasOwn(request.payload, 'signal'), false);
    if (!['list_apps', 'get_app_state'].includes(name)) assert.equal(session.observationRequired, true);
  });
}

test('a pre-cancelled call starts neither animation nor input', async () => {
  const { tools } = makeTools(true);
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  await assert.rejects(tools.click.execute({ app: 'fixture', x: 10, y: 20 }, { signal: controller.signal }), /cancelled/);
  assert.equal(backend.processes.length, 0);
});

test('cancelling during pointer animation prevents dispatch and closes the overlay', async () => {
  const { tools, session } = makeTools(true);
  const controller = new AbortController();
  const pending = settled(tools.click.execute({ app: 'fixture', x: 10, y: 20 }, { signal: controller.signal }));
  const play = await backend.waitForRequest((request) => request.proc.kind === 'overlay');
  controller.abort(new Error('user cancelled'));
  await nextTurn();
  backend.reply(play, { event: 'arrived' });
  await nextTurn();
  for (const request of backend.requests.filter(isKernelRequest)) backend.reply(request, successfulReply(request));
  const outcome = await pending;
  assert.match(outcome.error?.message ?? '', /cancelled|aborted/);
  assert.equal(backend.requests.filter(isKernelRequest).length, 0);
  assert.ok(backend.requests.some((request) => request.payload.op === 'exit'));
  assert.equal(session.observationRequired, true);
});

test('a cancelled queued request is never sent and does not kill the active kernel', async () => {
  const busy = invokePowerShell({ action: 'list_apps' });
  const request = await backend.waitForRequest(isKernelRequest);
  const controller = new AbortController();
  const queued = settled(invokePowerShell({ action: 'type_text', app: 'fixture', text: 'sample' }, { signal: controller.signal }));
  await nextTurn();
  controller.abort(new Error('user cancelled'));
  assert.equal(request.proc.killed, false);
  backend.reply(request, successfulReply(request));
  await busy;
  assert.match((await queued).error?.message ?? '', /cancelled/);
  assert.equal(backend.requests.filter(isKernelRequest).length, 1);
  assert.equal(request.proc.killed, false);
});

test('a pipe failure rejects the current request and the next call starts a new kernel', async () => {
  const pending = settled(invokePowerShell({ action: 'list_apps' }));
  const failed = await backend.waitForRequest(isKernelRequest);
  failed.proc.stdin.emit('error', new Error('EPIPE'));
  assert.match((await pending).error?.message ?? '', /stdin is unavailable/);
  const next = invokePowerShell({ action: 'list_apps' });
  const restarted = await backend.waitForRequest((request) => isKernelRequest(request) && request.proc !== failed.proc);
  backend.reply(restarted, successfulReply(restarted));
  assert.equal((await next).ok, true);
  assert.equal(failed.proc.killed, true);
});
