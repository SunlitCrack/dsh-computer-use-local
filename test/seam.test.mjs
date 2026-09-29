import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const CONFIG = { updateCheck: false, audit: false, fx: { overlay: false } };

/** Minimal exclusive registry mirroring @deepseek-ai/dsh-computer-use. */
function makeSeam(initialRegistration) {
  const seam = {
    registration: initialRegistration,
    register(name) {
      if (seam.registration !== undefined) {
        throw new Error(`computer use provider "${seam.registration}" is already registered`);
      }
      seam.registration = name;
      return () => {
        if (seam.registration === name) seam.registration = undefined;
      };
    },
  };
  return seam;
}

function makeHarness({ seam, promptSections } = {}) {
  const names = [];
  const sections = [];
  const warnings = [];
  const cleanups = [];
  let injectCallback = null;
  const ctx = {
    tools: {
      register(tool) {
        names.push(tool.name);
        return () => {
          const at = names.indexOf(tool.name);
          if (at >= 0) names.splice(at, 1);
        };
      },
    },
    get(name) {
      if (name === 'computerUse') return seam;
      if (name === 'systemPrompt') {
        return promptSections === null ? undefined : {
          section(section) {
            sections.push(section.name);
            return () => {
              const at = sections.indexOf(section.name);
              if (at >= 0) sections.splice(at, 1);
            };
          },
        };
      }
      return undefined;
    },
    logger() {
      return { info() {}, warn(message) { warnings.push(String(message)); } };
    },
    effect(factory) {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    inject(_services, callback) {
      injectCallback = callback;
      return () => { injectCallback = null; };
    },
    on() { return () => {}; },
  };
  return {
    ctx, names, sections, warnings, cleanups,
    fireInject(injected) { injectCallback?.(injected ?? ctx); },
    hasInjectWatch() { return injectCallback !== null; },
  };
}

// Cleanup is async since 0.3.1: the seam disposal is awaited, so unload must be too.
async function unload(harness) {
  for (const cleanup of harness.cleanups.reverse()) await cleanup();
  harness.cleanups.length = 0;
}

test('without the seam the ten tools register directly', async () => {
  const h = makeHarness();
  apply(h.ctx, CONFIG);
  assert.equal(h.names.length, 10);
  assert.deepEqual(h.sections, ['tool:computer-use']);
  await unload(h);
  assert.equal(h.names.length, 0);
});

test('a free seam slot is claimed and released on unload', async () => {
  const seam = makeSeam(undefined);
  const h = makeHarness({ seam });
  apply(h.ctx, CONFIG);
  assert.equal(seam.registration, 'mimi-computer-use');
  assert.equal(h.names.length, 10);
  // The late-arrival watch stays idempotent once the slot is ours.
  h.fireInject();
  assert.equal(seam.registration, 'mimi-computer-use');
  await unload(h);
  assert.equal(seam.registration, undefined);
  assert.equal(h.names.length, 0);
});

test('a seam slot held by another provider stands the tools down', async () => {
  const seam = makeSeam('cua-driver-native');
  const h = makeHarness({ seam });
  apply(h.ctx, CONFIG);
  assert.equal(h.names.length, 0);
  assert.deepEqual(h.sections, []);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /cua-driver-native/);
  await unload(h);
});

test('a late seam whose slot is taken removes the already-registered tools', async () => {
  const h = makeHarness();
  apply(h.ctx, CONFIG);
  assert.equal(h.names.length, 10);
  assert.ok(h.hasInjectWatch());
  const taken = makeSeam('cua-driver-native');
  h.fireInject({ computerUse: taken });
  assert.equal(h.names.length, 0);
  assert.deepEqual(h.sections, []);
  assert.equal(h.warnings.length, 1);
  await unload(h);
});

test('a late seam with a free slot is claimed without disturbing the tools', async () => {
  const h = makeHarness();
  apply(h.ctx, CONFIG);
  const seam = makeSeam(undefined);
  h.fireInject({ computerUse: seam });
  assert.equal(seam.registration, 'mimi-computer-use');
  assert.equal(h.names.length, 10);
  await unload(h);
  assert.equal(seam.registration, undefined);
});
