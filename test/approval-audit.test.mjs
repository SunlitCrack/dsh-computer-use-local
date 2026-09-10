// Temporary verification of the fail-closed approval, audit trail, and
// hide_cursor plumbing introduced with the official-parity fixes.
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../lib/tools.js';
import { setAuditEnabled } from '../lib/audit.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

const AUDIT_HOME = mkdtempSync(join(tmpdir(), 'dsh-cu-audit-'));
process.env.DSH_COMPUTER_USE_HOME = AUDIT_HOME;
const AUDIT_FILE = join(AUDIT_HOME, 'audit', 'computer-use.jsonl');

function auditLines() {
  if (!existsSync(AUDIT_FILE)) return [];
  return readFileSync(AUDIT_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// Audit writes are fire-and-forget; poll until the expected record lands.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForAudit(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = auditLines().find(pred);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

const build = (approvalService) => {
  const ctx = { get: (name) => (name === 'approval' ? approvalService : null) };
  const tools = buildTools(ctx, {
    state: null,
    lastScreenPoint: null,
    requireReady() {},
    invalidate() {},
    recordAction() {},
    elementScreenPoint: () => null,
    toScreenPoint: () => null,
    requireElement: () => { throw new Error('no session'); },
    windowScreenPoint: () => null,
  }, { askBeforeActions: true, fx: { overlay: false } });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
};

// 1) fail-closed: no approval service at all
{
  const tools = build(null);
  let threw = '';
  try { await tools.click.execute({ app: 'ghost', x: 1, y: 1 }, {}); } catch (e) { threw = e.message; }
  check('click without approval service is refused', /no approval channel/.test(threw), threw.slice(0, 120));
  const refusedRec = await waitForAudit((r) => r.method === 'click' && r.outcome === 'refused');
  check('refusal is audited as refused', refusedRec != null, JSON.stringify(refusedRec));
}

// 2) fail-closed: service present but no agent context
{
  const tools = build({ async request() { return 'allowed-once'; } });
  let threw = '';
  try { await tools.click.execute({ app: 'ghost', x: 1, y: 1 }, {}); } catch (e) { threw = e.message; }
  check('click without agent context is refused', /no approval channel/.test(threw), threw.slice(0, 120));
}

// 3) approval denied by answerer
{
  const tools = build({ async request() { return 'denied'; } });
  let threw = '';
  try { await tools.click.execute({ app: 'ghost', x: 1, y: 1 }, { agent: {}, callId: 't1' }); } catch (e) { threw = e.message; }
  check('denied approval refuses the action', /not approved/.test(threw), threw.slice(0, 120));
}

// 4) approval granted -> kernel reached (nonexistent app fails inside uia, not at approval)
{
  const requested = [];
  const tools = build({ async request(req) { requested.push(req); return 'allowed-once'; } });
  let threw = '';
  try { await tools.click.execute({ app: 'no-such-app-xyz', x: 1, y: 1 }, { agent: {}, callId: 't2' }); } catch (e) { threw = e.message; }
  check('granted approval lets the action reach the kernel', /target window not found/.test(threw), threw.slice(0, 120));
  check('approval request carries toolName/callId/reason', requested.length === 1 && requested[0].toolName === 'click' && requested[0].callId === 't2' && typeof requested[0].reason === 'string', JSON.stringify(requested[0] ?? {}).slice(0, 120));
}

// 5) audit metadata shape on success
{
  const tools = build(null);
  const r = await tools.list_apps.execute({}, {});
  check('list_apps works through the audit wrapper', r.ok === true, `apps=${r.apps?.length}`);
  const rec = await waitForAudit((x) => x.method === 'list_apps' && x.outcome === 'ok');
  check('success audited with hashed app and byte counts', rec != null && (rec.app === null || /^sha256:[0-9a-f]{16}$/.test(rec.app)) && rec.resultBytes > 0 && rec.durationMs >= 0, JSON.stringify(rec));
  check('audit record never contains raw app name or arguments', !JSON.stringify(auditLines()).includes('no-such-app-xyz'));
}

// 6) audit can be disabled
{
  setAuditEnabled(false);
  const tools = build(null);
  await tools.list_apps.execute({}, {});
  await sleep(400); // allow any (unexpected) flush attempt to land
  const okRecs = auditLines().filter((r) => r.method === 'list_apps' && r.outcome === 'ok');
  setAuditEnabled(true);
  check('audit=false records nothing', okRecs.length === 1, `list_apps ok records: ${okRecs.length}`); // only the earlier enabled run
}

// 7) askBeforeActions:false explicitly bypasses approval (demo/non-agent hosts)
{
  const ctx = { get: () => null };
  const tools = Object.fromEntries(
    buildTools(ctx, {
      state: null,
      lastScreenPoint: null,
      requireReady() {},
      invalidate() {},
      recordAction() {},
      elementScreenPoint: () => null,
      toScreenPoint: () => null,
      requireElement: () => { throw new Error('no session'); },
      windowScreenPoint: () => null,
    }, { askBeforeActions: false, fx: { overlay: false } })
      .map((t) => [t.name, t]),
  );
  let threw = '';
  try { await tools.click.execute({ app: 'no-such-app-xyz', x: 1, y: 1 }, {}); } catch (e) { threw = e.message; }
  check('askBeforeActions=false lets actions run without any approval service', /target window not found/.test(threw), threw.slice(0, 120));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
