import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerUseSession } from '../lib/session.js';

const state = {
  window: {
    hwnd: 987654,
    pid: 4321,
    processName: 'chrome',
    title: 'Inbox - Google Chrome',
    bounds: { x: 100, y: 200, width: 800, height: 600 },
  },
  elements: [{ index: 2, path: '0.1', frame: { x: 20, y: 30, width: 100, height: 40 } }],
};

test('snapshot accepts stable aliases for the same target window', () => {
  const session = new ComputerUseSession();
  session.store(state, 'Inbox');
  for (const app of ['Inbox', 'Inbox - Google', 'chrome', 'chrome.exe', '4321', 'pid:4321', '987654', 'hwnd:987654']) {
    assert.equal(session.requireReady(app, 'click'), state, app);
  }
  assert.throws(() => session.requireReady('notepad', 'click'), /does not match/);
});

test('every action invalidates indices and markers until a new observation', () => {
  const session = new ComputerUseSession();
  session.store(state, 'chrome');
  session.markers = [{ id: 'A1', x: 10, y: 10 }];
  session.invalidate();
  assert.equal(session.observationRequired, true);
  assert.deepEqual(session.markers, []);
  assert.throws(() => session.requireReady('chrome', 'scroll'), /previous action invalidated/);
  session.store(state, 'chrome');
  assert.doesNotThrow(() => session.requireReady('chrome', 'scroll'));
});

test('a new observation resets coordinate scale and cross-window trails', () => {
  const session = new ComputerUseSession();
  session.store(state, 'chrome');
  session.modelScale = 0.5;
  session.markers = [{ id: 'A1', x: 10, y: 10 }];
  session.recordAction('click', 150, 250);
  session.store({ ...state, window: { ...state.window, hwnd: 111, pid: 99, processName: 'notepad' } }, 'notepad');
  assert.equal(session.modelScale, 1);
  assert.deepEqual(session.markers, []);
  assert.equal(session.lastAction, null);
  assert.deepEqual(session.trail, []);
});
