import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function oneShot(name, args, { nativeKernel = false, missingShotDirectory = false, largeTree = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cu-mcp-test-'));
  const shotFile = missingShotDirectory ? join(dir, 'missing', 'shot.png') : join(dir, 'shot.png');
  const preload = nativeKernel ? [] : ['--require', fileURLToPath(new URL('./fixtures/mcp-kernel.cjs', import.meta.url))];
  const child = spawn(process.execPath, [...preload, 'mcp-server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      CU_SESSION_FILE: join(dir, 'session.json'),
      CU_SCREENSHOT_FILE: shotFile,
      DSH_COMPUTER_USE_HOME: dir,
      CU_TEST_LARGE_TREE: largeTree ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (largeTree) {
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 250);
  }
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP test server did not exit after stdin EOF'));
    }, 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  })}\n`);
  const code = await closed;
  assert.equal(code, 0, stderr);
  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(messages.length, 1, stdout.slice(0, 2000));
  assert.equal(messages[0].id, 1);
  return { dir, shotFile, result: messages[0].result };
}

function auditRecords(dir) {
  const file = join(dir, 'audit', 'computer-use.jsonl');
  assert.ok(existsSync(file), 'audit log must exist when the child has exited');
  return readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('one-shot MCP waits for an asynchronous tool reply and success audit before exit', async () => {
  const { dir, result } = await oneShot('list_apps', {}, { nativeKernel: true });
  assert.equal(result?.isError, false);
  assert.match(result?.content?.[0]?.text ?? '', /Running apps with windows/);
  const records = auditRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].method, 'list_apps');
  assert.equal(records[0].outcome, 'ok');
});

test('MCP observations return a PNG image block as well as the local screenshot', async () => {
  const { shotFile, result } = await oneShot('get_app_state', { app: 'fixture' });
  assert.equal(result.isError, false);
  const image = result.content.find((block) => block.type === 'image');
  assert.ok(image, 'the MCP host must receive the screenshot itself');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(readFileSync(shotFile), png);
  assert.ok(result.content.some((block) => block.type === 'text' && block.text.includes(shotFile)));
});

test('an unwritable local screenshot path does not remove the MCP image', async () => {
  const { shotFile, result } = await oneShot('get_app_state', { app: 'fixture' }, { missingShotDirectory: true });
  assert.equal(result.isError, false);
  assert.ok(result.content.some((block) => block.type === 'image'));
  assert.equal(existsSync(shotFile), false);
  assert.equal(result.content.some((block) => block.type === 'text' && block.text.includes('screenshot saved')), false);
});

test('one-shot MCP fully drains a large observation to a slow stdout reader', async () => {
  const { dir, result } = await oneShot('get_app_state', { app: 'fixture' }, { largeTree: true });
  assert.equal(result.isError, false);
  assert.ok(result.content[0].text.length > 1024 * 1024);
  assert.match(result.content[0].text, /large-observation-end/);
  assert.ok(result.content.some((block) => block.type === 'image'));
  assert.equal(auditRecords(dir)[0].outcome, 'ok');
});

test('one-shot MCP also flushes failed tool calls to the audit log', async () => {
  const { dir, result } = await oneShot('click', { app: 'fixture', x: 0, y: 0 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no app snapshot/);
  const records = auditRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].method, 'click');
  assert.equal(records[0].outcome, 'error');
});
