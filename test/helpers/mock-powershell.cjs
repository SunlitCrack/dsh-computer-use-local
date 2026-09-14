const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');

// Substitute only the OS process boundary. Tool definitions, serialization,
// queues, cancellation, and MCP dispatch still execute their production code.
function installPowerShellMock({ onRequest } = {}) {
  const originalSpawn = childProcess.spawn;
  const processes = [];
  const requests = [];
  const waiters = new Set();

  childProcess.spawn = (command, args) => {
    if (command !== 'powershell.exe') throw new Error(`unexpected test spawn: ${command}`);
    const proc = new EventEmitter();
    const script = args[args.indexOf('-File') + 1] ?? '';
    proc.kind = args.includes('-Command') ? 'restore' : /overlay\.ps1$/.test(script) ? 'overlay' : 'kernel';
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    let buffer = '';
    proc.stdin = new Writable({
      write(chunk, encoding, callback) {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const payload = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          const request = { proc, payload };
          requests.push(request);
          for (const waiter of waiters) {
            if (waiter.predicate(request)) {
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              waiter.resolve(request);
            }
          }
          onRequest?.(request);
          if (proc.kind === 'overlay' && payload.op === 'exit') queueMicrotask(() => proc.kill());
        }
        callback();
      },
    });
    proc.kill = () => {
      if (proc.killed) return false;
      proc.killed = true;
      proc.stdin.destroy();
      proc.stdout.end();
      proc.stderr.end();
      queueMicrotask(() => proc.emit('close', 0));
      return true;
    };
    processes.push(proc);
    if (proc.kind === 'restore') queueMicrotask(() => proc.kill());
    return proc;
  };
  syncBuiltinESMExports();

  return {
    processes,
    requests,
    waitForRequest(predicate) {
      const existing = requests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('test backend received no matching request'));
        }, 2000);
        waiters.add(waiter);
      });
    },
    reply(request, result) {
      if (!request.proc.killed) request.proc.stdout.write(`${JSON.stringify(result)}\n`);
    },
    clear() {
      requests.length = 0;
      processes.length = 0;
    },
    restore() {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    },
  };
}

module.exports = { installPowerShellMock };
