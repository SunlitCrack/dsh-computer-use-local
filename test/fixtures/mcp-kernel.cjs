const { installPowerShellMock } = require('../helpers/mock-powershell.cjs');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1EAAAAASUVORK5CYII=';
const largeTree = process.env.CU_TEST_LARGE_TREE === '1'
  ? `\nlarge-observation-start ${'x'.repeat(1024 * 1024)} large-observation-end`
  : '';
const backend = installPowerShellMock({
  onRequest(request) {
    if (request.proc.kind !== 'kernel') return;
    const result = request.payload.action === 'get_state' ? {
      ok: true,
      window: { hwnd: 101, pid: 42, processName: 'fixture', title: 'fixture', bounds: { x: 0, y: 0, width: 1, height: 1 }, foreground: true },
      elements: [{ index: 0, path: '', frame: { x: 0, y: 0, width: 1, height: 1 } }],
      elementCount: 1,
      treeText: `0 Window fixture frame=[0,0,1,1]${largeTree}`,
      screenshot: png,
      screenshotWidth: 1,
      screenshotHeight: 1,
      markers: [],
    } : { ok: true, apps: [], count: 0 };
    // Preserve an asynchronous process round trip so EOF handling is exercised.
    setTimeout(() => backend.reply(request, result), 20);
  },
});
