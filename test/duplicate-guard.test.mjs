import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

test('embedded and standalone loading register the tool surface only once', () => {
  const names = [];
  const cleanups = [];
  const ctx = {
    tools: { register(tool) { names.push(tool.name); } },
    get() { return undefined; },
    logger() { return { info() {}, warn() {} }; },
    effect(factory) {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
  };
  apply(ctx, { updateCheck: false, audit: false, fx: { overlay: false } });
  apply(ctx, { updateCheck: false, audit: false, fx: { overlay: false } });
  assert.equal(names.length, 10);
  assert.equal(new Set(names).size, 10);
  for (const cleanup of cleanups.reverse()) cleanup();
});

test('a throwing config does not wedge the duplicate guard', () => {
  const names = [];
  const cleanups = [];
  const ctx = {
    tools: { register(tool) { names.push(tool.name); } },
    get() { return undefined; },
    logger() { return { info() {}, warn() {} }; },
    effect(factory) {
      const cleanup = factory();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
  };
  // Invalid config value: Config throws before the guard key is claimed.
  assert.throws(
    () => apply(ctx, { updateCheck: false, audit: false, fx: { overlay: false }, maxNodes: 'abc' }),
    /maxNodes/,
  );
  // The next apply must still be able to register the tool surface.
  apply(ctx, { updateCheck: false, audit: false, fx: { overlay: false } });
  assert.equal(names.length, 10);
  for (const cleanup of cleanups.reverse()) cleanup();
});
