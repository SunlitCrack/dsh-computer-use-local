import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('one-shot MCP waits for an asynchronous tool reply before stdin-close exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cu-mcp-test-'));
  const child = spawn(process.execPath, ['mcp-server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      CU_SESSION_FILE: join(dir, 'session.json'),
      CU_SCREENSHOT_FILE: join(dir, 'shot.png'),
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
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_apps', arguments: {} },
  })}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(messages.length, 1, stdout);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].result?.isError, false);
  assert.match(messages[0].result?.content?.[0]?.text ?? '', /Running apps with windows/);
});
