// The ten Codex Computer Use tools, aligned with the official method surface:
// list_apps, get_app_state, click, perform_secondary_action, set_value,
// select_text, scroll, drag, press_key, type_text.
import { invokePowerShell } from './ps1.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { restoreSystemCursor } from './cursor.js';
import { auditToolCall } from './audit.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OVERLAY_PS1 = join(dirname(fileURLToPath(import.meta.url)), 'overlay.ps1');

// The overlay is a RESIDENT session (official semantics): it spawns on the
// first pointer action and stays alive BETWEEN actions — the software cursor
// stays parked at the last endpoint and the screen-edge glow keeps breathing —
// until the session ends. The session ends when the agent turn finishes
// (agent/status idle, hooked in index.js), after an idle gap, or on teardown.
// The overlay's stdin EOF also fades it out if this process dies first.
const OVERLAY_HOLD_MS = 12000;

let overlayProc = null;          // resident overlay child (one at a time)
let overlayIdleTimer = null;
let arrivalResolver = null;      // resolves the active play's arrived promise
let arrivalTimer = null;
let overlayGeneration = 0;       // increments per resident session spawn

function settleArrival() {
  if (arrivalTimer) { clearTimeout(arrivalTimer); arrivalTimer = null; }
  if (arrivalResolver) {
    const resolve = arrivalResolver;
    arrivalResolver = null;
    resolve();
  }
}

function armOverlayIdle() {
  if (overlayIdleTimer) clearTimeout(overlayIdleTimer);
  overlayIdleTimer = setTimeout(() => endOverlaySession(), OVERLAY_HOLD_MS);
  overlayIdleTimer.unref?.();
}

function endOverlaySession() {
  if (overlayIdleTimer) { clearTimeout(overlayIdleTimer); overlayIdleTimer = null; }
  settleArrival();
  const proc = overlayProc;
  overlayProc = null;
  if (!proc) return;
  try {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify({ op: 'exit' })}\n`);
    proc.stdin.end();
  } catch { /* best-effort: the close failsafe below still restores */ }
  // If the overlay misses the graceful exit, kill it; either way make sure the
  // user's cursor scheme comes back (the overlay restores on its own clean
  // exit, but kill() skips its ProcessExit handler).
  setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
    restoreSystemCursor();
  }, 1500).unref?.();
}

function ensureOverlayProcess() {
  if (overlayProc) return overlayProc;
  const generation = ++overlayGeneration;
  const proc = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', OVERLAY_PS1,
  ], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  overlayProc = proc;
  proc.stdout.setEncoding('utf8');
  let stdout = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      try {
        if (JSON.parse(line).event === 'arrived') settleArrival();
      } catch { /* ignore non-event output */ }
    }
  });
  proc.once('error', () => { try { proc.kill(); } catch { /* already gone */ } });
  proc.once('close', () => {
    if (overlayProc === proc) {
      overlayProc = null;
      // The overlay owns the cursor borrow for the whole session; if it died
      // without running its own restore (crash, kill), reload the scheme here.
      if (generation === overlayGeneration) restoreSystemCursor();
    }
  });
  return proc;
}

export function stopOverlay() {
  endOverlaySession();
}

export { endOverlaySession };

/** Debug: ask the resident overlay to dump strip/window state to %TEMP%\dsh-cu-overlay-diag.txt. */
export function overlayProbe() {
  try { overlayProc?.stdin.write(`${JSON.stringify({ op: 'probe' })}\n`); } catch { /* best-effort */ }
}

export function buildMotionPoints(previousPoint, targets) {
  const validTargets = targets.filter((point) => (
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
  ));
  return [previousPoint ?? { x: 0, y: 0 }, ...validTargets];
}

/**
 * Start a desktop software-cursor interaction on the resident overlay session.
 * The child reports when the cursor reaches the interaction point; the caller
 * then commits the real UI action so visual motion never trails the mutation.
 * After the commit the session KEEPS running (cursor parked, glow breathing) —
 * endOverlaySession() fades it when the turn ends or the idle gap elapses.
 */
export function playOverlay(points, kind, {
  lens = false,
  fog = true,
  pulse = kind === 'click',
  interactionIndex = points.length - 1,
} = {}) {
  if (overlayIdleTimer) { clearTimeout(overlayIdleTimer); overlayIdleTimer = null; }
  // A previous play that never settled resolves here; the resident session
  // itself survives and accepts the new play command.
  settleArrival();

  const proc = ensureOverlayProcess();
  const payload = { lens, fog, pulse, interactionIndex };
  const settled = new Promise((resolve) => { arrivalResolver = resolve; });

  try {
    if (!proc.playStarted) {
      // The first motion initialises the session (and switches the overlay
      // into resident/serve mode on the PS side).
      proc.playStarted = true;
      proc.stdin.write(`${JSON.stringify({ ...payload, points, kind, serve: true })}\n`);
    } else {
      proc.stdin.write(`${JSON.stringify({ op: 'play', ...payload, points, kind })}\n`);
    }
    arrivalTimer = setTimeout(() => settleArrival(), 6500);
    // Arm the idle timer at PLAY time, not only on commit: if the caller dies
    // between arrival and commit (tool error, host crash), the session would
    // otherwise sit in its commit gate holding the borrowed cursor forever.
    armOverlayIdle();
  } catch {
    settleArrival();
  }
  return {
    arrived: settled,
    commit() {
      try {
        if (proc?.stdin.writable) proc.stdin.write(`${JSON.stringify({ op: 'commit' })}\n`);
      } catch { /* animation is best-effort */ }
      armOverlayIdle();
    },
    cancel() {
      // Keep the session alive: the cursor stays parked for the next action.
      settleArrival();
    },
  };
}

function text(text) {
  return [{ type: 'text', text }];
}

function summary(parts) {
  return text(parts.filter(Boolean).join(' '));
}

const REOBSERVE_TEXT = 'Next: call get_app_state to verify before any other action.';

// Legends appended to treeText when the kernel actually drew the aids.
const GRID_LEGEND =
  "\nGrid: numbered crosshairs are drawn on the screenshot — click({marker:'D6'}) clicks the element under that marker (UIA-snapped to its center). Column rows are letter+digit (A1..); 'N' ids (N1, N2, …) mark controls the lattice missed. Prefer marker for visible targets; use x/y only for unmarked areas.";
const LAST_POINT_LEGEND =
  '\nAmber ring: where the last action landed — check it after each action to confirm the effect.';
const OBSERVATION_REQUIRED_PROPERTY = {
  observationRequired: {
    type: 'boolean',
    required: true,
    description: 'True after every action attempt. Call get_app_state again before the next action.',
  },
};

const APP_PARAM = {
  type: 'string',
  description:
    'App/process name (chrome, notepad.exe), window title substring, pid:<number>, hwnd:<number>, or a bare PID/HWND number.',
};

function pendingCall(title) {
  return {
    card: 'generic',
    title,
    kind: 'computer-use',
    rawInput: title,
  };
}

/**
 * Rescale tree-line frame=[x,y,w,h] values from capture pixels to the
 * attached-image pixel space the model actually sees and clicks in, so tree
 * coordinates and screenshot coordinates are always one space. The kernel
 * emits frames in window-relative capture pixels; the attachment pipeline may
 * downscale the screenshot (ratio recorded as session.modelScale).
 */
export function scaleTreeFrames(treeText, scale) {
  if (!treeText || !Number.isFinite(scale) || scale === 1) return treeText;
  return treeText.replace(/frame=\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/g,
    (_m, x, y, w, h) => `frame=[${Math.round(Number(x) * scale)},${Math.round(Number(y) * scale)},`
      + `${Math.round(Number(w) * scale)},${Math.round(Number(h) * scale)}]`);
}

/**
 * Build all ten tool definitions.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./session.js').ComputerUseSession} session
 * @param {object} config plugin config (askBeforeActions, maxDepth, maxNodes,
 *   includeScreenshot, annotate)
 */
export function buildTools(ctx, session, config = {}) {
  const askBeforeActions = config.askBeforeActions !== false;
  const maxDepth = config.maxDepth ?? 15;
  const maxNodes = config.maxNodes ?? 1600;
  const includeScreenshot = config.includeScreenshot !== false;
  const annotate = config.annotate ?? {};
  const annotateGrid = annotate.grid !== false;        // numbered crosshair grid on screenshots
  const annotateLastPoint = annotate.lastPoint !== false; // amber ring at the last action point
  const annotateActivate = annotate.activate !== false;   // bring the window forward before capture
  const fx = config.fx ?? {};
  const fxScreenshot = fx.screenshot === true;    // debug-only screenshot compositing
  const fxOverlay = fx.overlay !== false;         // desktop software-cursor animation
  const fxLensFrame = typeof fx.lensFrame === 'number' ? fx.lensFrame : 28;
  const fxTrail = fx.trail === true;
  // The 3D LensSequence is not a click marker. Keep it explicit for asset
  // debugging; normal clicks use the fog/press/ripple drawn by the overlay.
  const fxLens = fx.lens === true;

  async function requireApproval(ctx, exec, toolName, reason) {
    if (!askBeforeActions) return; // explicit opt-out in the plugin config
    const appr = ctx.get('approval');
    const agent = exec?.agent;
    if (!appr || !agent) {
      // Fail closed: with askBeforeActions on, a mutating action without an
      // approval channel must refuse loudly instead of running unapproved.
      throw new Error(
        `${toolName}: askBeforeActions=true but no approval channel is available ` +
        `(${appr ? 'no agent context' : 'approval service not registered'}). ` +
        'Run the action inside an agent turn, or set askBeforeActions:false.',
      );
    }
    const outcome = await appr.request({
      agent,
      toolName,
      callId: exec.callId,
      reason,
    });
    if (outcome !== 'allowed-once') {
      throw new Error(`computer use action not approved (answerer said: ${outcome})`);
    }
  }

  function requireFreshSnapshot(app, toolName) {
    return session.requireReady(app, toolName);
  }

  async function runMutation(operation) {
    try {
      const result = await operation();
      return { ...result, observationRequired: true };
    } finally {
      // Even a failed input may have partially changed the UI. Force a fresh
      // observation before any follow-up action instead of trusting stale
      // element paths, bounds, focus, or marker positions.
      session.invalidate();
    }
  }

  /** Build the fx payload for the next get_app_state screenshot. */
  function fxPayload(pulsePoint = null) {
    if (!fxScreenshot) return { disabled: true };
    const payload = {};
    if (session.lastAction) {
      payload.cursor = { x: session.lastAction.x, y: session.lastAction.y };
      if (pulsePoint) payload.fog = { x: pulsePoint.x, y: pulsePoint.y, pulse: 0.7 };
      else payload.fog = { x: session.lastAction.x, y: session.lastAction.y, pulse: 0 };
      if (fxLens) payload.lens = { x: session.lastAction.x, y: session.lastAction.y, frame: fxLensFrame };
    }
    if (fxTrail && session.trail.length > 1) {
      payload.trail = session.trail.slice(1).map((p) => ({ x: p.x, y: p.y }));
    }
    return payload;
  }

  function elementPoint(index) {
    return index == null ? null : session.elementScreenPoint(index);
  }

  /**
   * Identity captured with the snapshot for one element. The kernel addresses
   * elements by a positional path (child ordinals), so a re-rendered window can
   * make the same path hit a NEIGHBOUR (LOCAL PATCH P3). The kernel now checks
   * this identity before acting and re-finds the element by AutomationId /
   * Name when the path drifted.
   */
  function elementIdentity(el) {
    return {
      name: el?.name ?? '',
      automationId: el?.automationId ?? '',
      role: el?.role ?? '',
    };
  }

  /** Model coordinates arrive in the ATTACHED image space (DSH may downscale);
   *  map them back to the capture space before kernel math. */
  function modelCoordinate(value) {
    if (value == null) return null;
    const scale = session.modelScale || 1;
    return scale === 1 ? Number(value) : Number(value) / scale;
  }

  function coordinatePoint(x, y) {
    return x == null || y == null ? null : session.toScreenPoint(modelCoordinate(x), modelCoordinate(y));
  }

  /** Display label for a snapshot element, shared by snap notes and nearby lists. */
  function elementLabel(el) {
    const name = String(el.name ?? '').trim();
    const role = String(el.role ?? 'Element');
    if (name) return `${role} "${name}"`.slice(0, 56);
    if (el.automationId) return `${role} #${String(el.automationId)}`.slice(0, 56);
    return `${role}#${el.index}`;
  }

  /**
   * Report the controls nearest a point that did NOT qualify as a snap host, so
   * an unsnapped click can name its neighbours instead of leaving the model to
   * guess.
   *
   * Two rules make the list useful rather than merely non-empty:
   *  - A container that CONTAINS the point is not a neighbour, it is the room
   *    the click is standing in. Counting it (at distance 0) would put a
   *    whole-window Group at the top and bury the actual controls.
   *  - The list is not limited to a fixed radius: when every candidate is far
   *    away, an empty answer is worse than an honest "nearest is 340px left".
   *    Nearby controls are preferred; otherwise the nearest few are reported.
   */
  function nearbyElements(cx, cy, elements) {
    const w = session.state?.window?.bounds;
    const radius = w
      ? Math.min(80, Math.max(32, Math.round(0.04 * Math.min(w.width, w.height))))
      : 48;
    const cap = w
      ? Math.max(96, Math.round(0.08 * Math.min(w.width, w.height)))
      : 96;
    const hits = [];
    for (const el of elements) {
      const f = el?.frame;
      if (!f || f.width <= 0 || f.height <= 0) continue;
      // Skip the container the point sits inside: it is context, not a target,
      // and its zero distance would outrank every real control.
      if (Math.min(f.width, f.height) > cap) continue;
      const dx = Math.round(f.x + f.width / 2 - cx);
      const dy = Math.round(f.y + f.height / 2 - cy);
      const dist = Math.round(Math.hypot(dx, dy));
      hits.push({ el, dx, dy, dist });
    }
    hits.sort((a, b) => a.dist - b.dist);
    // Prefer enabled controls: a disabled one cannot be the intended target and
    // must not outrank a usable neighbour just because it is nearer.
    const usable = hits.filter(({ el }) => {
      if (el.enabled === false) return false;
      const secondary = Array.isArray(el.secondaryActions) ? el.secondaryActions : [];
      return el.settable === true
        || secondary.some((a) => a === 'Invoke' || a === 'Toggle' || a === 'ExpandCollapse' || a === 'SelectionItem');
    });
    const enabledOnly = hits.filter(({ el }) => el.enabled !== false);
    const pool = usable.length > 0 ? usable : (enabledOnly.length > 0 ? enabledOnly : hits);
    const within = pool.filter((h) => h.dist <= radius);
    const chosen = (within.length > 0 ? within : pool).slice(0, 5);
    return {
      radius,
      total: hits.length,
      nearestDistance: pool.length > 0 ? pool[0].dist : null,
      list: chosen.map(({ el, dx, dy, dist }) => ({
        label: elementLabel(el),
        dx,
        dy,
        dist,
        disabled: el.enabled === false ? true : undefined,
        index: typeof el.index === 'number' ? el.index : null,
      })),
    };
  }

  /**
   * Snap a capture-pixel point (e.g. a grid marker) to the smallest interactive
   * UIA element frame containing it, so click precision does not depend on the
   * grid pitch. Operates on the latest kernel snapshot — the same capture-pixel
   * space the markers were computed in.
   *
   * Returns an explicit verdict rather than a bare point: a caller that only
   * learns "a click happened" cannot tell a snapped click from a guessed pixel,
   * which is how a miss used to look like a success.
   *
   * The snap must never move the click far. A container that merely contains
   * the point is not a target — snapping to its centre is the same class of
   * error as clicking a guessed pixel, only harder to notice because the tool
   * reports success. Two guards enforce that:
   *  - the host must be small in BOTH dimensions (minSide), so a full-width
   *    toolbar strip is rejected even though it is only ~160px tall;
   *  - the displacement from the marker to the chosen centre is capped well
   *    below a control pitch, so an off-centre point inside a large element
   *    falls back to the raw pixel instead of sliding across the window.
   */
  function snapMarkerPoint(cx, cy) {
    const elements = session.state?.elements ?? [];
    const w = session.state?.window?.bounds;
    // Snap hosts are controls, not containers. 0.18*min(w,h) (~297px on a
    // 2561x1637 window) admitted 163px-tall toolbar strips and moved a click
    // 287px while reporting success; 0.08*min(w,h) (~132px) keeps buttons,
    // tabs, list rows and small groups while rejecting bands.
    const hostCap = w
      ? Math.max(96, Math.round(0.08 * Math.min(w.width, w.height)))
      : 96;
    // A snap may not move the pointer more than this from the marker.
    const moveCap = Math.max(48, Math.round(0.25 * hostCap));
    let best = null;
    let bestDistance = Infinity;
    const rejected = [];
    for (const el of elements) {
      if (!el || el.enabled === false) continue;
      const secondaryActions = Array.isArray(el.secondaryActions) ? el.secondaryActions : [];
      const interactive = el.settable === true
        || secondaryActions.some((action) => (
          action === 'Invoke' || action === 'Toggle' || action === 'ExpandCollapse'
          || action === 'SelectionItem' || action === 'ScrollItem'
        ));
      if (!interactive) continue;
      const f = el.frame;
      if (!f || cx < f.x || cx > f.x + f.width || cy < f.y || cy > f.y + f.height) continue;
      const centerX = f.x + f.width / 2;
      const centerY = f.y + f.height / 2;
      const shift = Math.hypot(centerX - cx, centerY - cy);
      const minSide = Math.min(f.width, f.height);
      if (minSide > hostCap) {
        // Too big to be a control; remember it so a failed snap can explain why.
        rejected.push({ el, shift, reason: 'container' });
        continue;
      }
      if (shift > moveCap) {
        rejected.push({ el, shift, reason: 'would-move' });
        continue;
      }
      // Prefer the smallest host, then the smallest displacement.
      const area = f.width * f.height;
      if (!best || area < best.area || (area === best.area && shift < bestDistance)) {
        best = { el, area, shift };
        bestDistance = shift;
      }
    }
    if (!best) {
      // Name what actually sits under the point when only containers do: that
      // is the honest answer ("this is a container band, not a control") and it
      // tells the caller why no snap happened.
      const near = nearbyElements(cx, cy, elements);
      let containerNote = null;
      if (rejected.length > 0) {
        const container = rejected.find((r) => r.reason === 'container');
        const mover = rejected.find((r) => r.reason === 'would-move');
        if (container) {
          containerNote = `only containers cover this point (e.g. ${elementLabel(container.el)},`
            + ` would move ${Math.round(container.shift)}px)`;
        } else if (mover) {
          containerNote = `nearest control would move the click ${Math.round(mover.shift)}px`
            + ` (limit ${moveCap}px)`;
        }
      }
      return {
        point: { x: cx, y: cy },
        snapped: false,
        note: 'no button-like element, clicked marker point',
        nearby: near,
        containerNote,
        hostCap,
        moveCap,
      };
    }
    const f = best.el.frame;
    return {
      point: { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) },
      snapped: true,
      label: elementLabel(best.el),
      elementIndex: typeof best.el.index === 'number' ? best.el.index : null,
      shift: Math.round(best.shift),
      note: `snapped to ${elementLabel(best.el)} center`,
      nearby: null,
      hostCap,
      moveCap,
    };
  }

  const byteLen = (value) => {
    try { return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); } catch { return 0; }
  };

  // Metadata-only audit (official-style): method, hashed app, byte counts,
  // outcome, duration — never arguments or returned content.
  function withAudit(tool) {
    if (typeof tool.execute !== 'function') return tool;
    return {
      ...tool,
      async execute(args, exec) {
        const startedAt = Date.now();
        try {
          exec?.signal?.throwIfAborted();
          const result = await tool.execute(args, exec);
          auditToolCall({
            method: tool.name,
            app: args?.app,
            inputBytes: byteLen(args),
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
            via: result?.via ?? null,
            resultBytes: byteLen(result),
          });
          return result;
        } catch (error) {
          auditToolCall({
            method: tool.name,
            app: args?.app,
            inputBytes: byteLen(args),
            outcome: /not approved|no approval channel/.test(String(error?.message)) ? 'refused' : 'error',
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      },
    };
  }

  /** Run the pointer motion before and during the real interaction. */
  async function withPointerMotion(kind, targets, execute, { pulse = kind === 'click', interactionIndex, signal } = {}) {
    signal?.throwIfAborted();
    const validTargets = targets.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    // Keep duplicate waypoints: for a drag, index 1 is the press point even when
    // the previous cursor position already equals that point.
    const points = buildMotionPoints(session.lastScreenPoint, validTargets);
    const resolvedInteractionIndex = Math.min(
      interactionIndex ?? points.length - 1,
      points.length - 1,
    );
    const motion = fxOverlay && points.length > 1
      ? playOverlay(points, kind, {
          lens: fxLens,
          fog: true,
          pulse,
          interactionIndex: resolvedInteractionIndex,
        })
      : null;

    let onAbort;
    try {
      if (motion) {
        if (signal) {
          const aborted = new Promise((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error('computer use action aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
          });
          await Promise.race([motion.arrived, aborted]);
        } else {
          await motion.arrived;
        }
      }
      signal?.throwIfAborted();
      // When the overlay is running it owns hiding the system cursor for the
      // whole animation; otherwise uia.ps1 hides it around the real input.
      const pendingResult = execute(motion);
      motion?.commit();
      const result = await pendingResult;
      const fallback = validTargets.at(-1) ?? null;
      const finalPoint = result && Number.isFinite(result.x) && Number.isFinite(result.y)
        ? { x: result.x, y: result.y }
        : fallback;
      if (finalPoint) session.recordAction(kind, finalPoint.x, finalPoint.y);
      return result;
    } catch (error) {
      motion?.cancel();
      if (motion && signal?.aborted) endOverlaySession();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  return [
    // ---------------------------------------------------------------- list_apps
    {
      name: 'list_apps',
      description:
        'List the apps on this computer. Returns the apps that currently have visible top-level windows, with window titles, process ids and whether each is the foreground window.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            apps: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hwnd: { type: 'integer' },
                  app: { type: 'string', required: true },
                  pid: { type: 'integer', required: true },
                  title: { type: 'string', required: true },
                  foreground: { type: 'boolean' },
                },
              },
            },
            count: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const lines = value.apps.map((a) => {
            const fg = a.foreground ? ' (foreground)' : '';
            return `- ${a.app} (pid ${a.pid})${fg}: ${a.title}`;
          });
          return text(`Running apps with windows (${value.count}):\n${lines.join('\n')}`);
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return invokePowerShell({ action: 'list_apps' }, { signal: exec?.signal });
      },
    },

    // ------------------------------------------------------------ get_app_state
    {
      name: 'get_app_state',
      description:
        `Start an app use session if needed, then get the state of the app's key window and return a screenshot and accessibility tree. ` +
        'Call it before the first action and again after every action attempt; stale snapshots are rejected. ' +
        'Returns the accessibility tree with numbered element indices — every line carries frame=[x,y,w,h] in screenshot pixels, '
        + 'so a tree hit can be clicked directly by its frame center without reading the screenshot — plus a screenshot of the window. ' +
        'Coordinates in click/scroll/drag are screenshot-relative pixels.',
      parameters: {
        app: APP_PARAM,
        maxDepth: {
          type: 'integer',
          description: 'Override the tree depth budget for THIS call only (0..50, clamped). Chromium/Electron toolbars and sidebars sit at depth 11-12, so raise this when a tree looks suspiciously shallow or when truncatedByDepth came back true. The configured default applies when omitted.',
        },
        maxNodes: {
          type: 'integer',
          description: 'Override the node budget for THIS call only (1..5000, clamped). Raise together with maxDepth when truncatedByNodes came back true.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            window: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                hwnd: { type: 'integer', required: true },
                pid: { type: 'integer', required: true },
                processName: { type: 'string', required: true },
                title: { type: 'string', required: true },
                bounds: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'integer', required: true },
                    y: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                },
                foreground: { type: 'boolean', required: true },
                // P5: how the window was chosen when the caller passed an app
                // name (process match vs title match, and how many candidates).
                pick: {
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        by: { type: 'string' },
                        candidates: { type: 'integer' },
                        ambiguous: { type: 'boolean' },
                        foreground: { type: 'boolean' },
                        title: { type: 'string' },
                      },
                    },
                    { type: 'null' },
                  ],
                },
              },
            },
            elementCount: { type: 'integer', required: true },
            nodeCount: { type: 'integer' },
            interactiveCount: { type: 'integer' },
            maxSeenDepth: { type: 'integer' },
            maxDepthUsed: { type: 'integer' },
            maxNodesUsed: { type: 'integer' },
            lazyTreeRetries: {
              type: 'integer',
              description: 'How many times the walk was repeated because Chromium had not finished building its accessibility tree. 0 means the first pass already saw the full tree.',
            },
            lazyTreeUnresolved: {
              type: 'boolean',
              description: 'True when those rebuild attempts still produced a near-empty tree; the app may expose almost nothing, or its provider is still building.',
            },
            lazyTreeGained: {
              type: 'integer',
              description: 'Elements the winning rebuild added over the first pass. 0 means retrying did not help.',
            },
            truncated: { type: 'boolean' },
            truncatedByDepth: { type: 'boolean' },
            truncatedByNodes: { type: 'boolean' },
            treeText: { type: 'string', required: true },
            screenshotRef: {
              oneOf: [
                { type: 'object', additionalProperties: true },
                { type: 'null' },
              ],
              description: 'Durable image attachment reference when a screenshot was captured.',
            },
          },
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.treeText }];
          if (value.screenshotRef) {
            blocks.push({ type: 'image', attachment: value.screenshotRef });
          }
          return blocks;
        },
      },
      async execute(args, exec) {
        // Keep repeated observations bound to the same top-level window. A
        // process-name selector can resolve to a different window between
        // calls in Chrome/Electron; explicit hwnd:<n> is how callers switch.
        const continuationHwnd = session.matchesApp(args.app)
          ? session.state?.window?.hwnd ?? null
          : null;
        const requestedMaxDepth = args.maxDepth ?? maxDepth;
        const requestedMaxNodes = args.maxNodes ?? maxNodes;
        const result = await invokePowerShell({
          action: 'get_state',
          app: args.app,
          hwnd: continuationHwnd,
          // Per-call override wins over the configured default; the kernel
          // clamps both to its own range, so a wild value cannot explode cost.
          maxDepth: requestedMaxDepth,
          maxNodes: requestedMaxNodes,
          includeScreenshot,
          fx: fxPayload(),
          annotate: { grid: annotateGrid, lastPoint: annotateLastPoint, activate: annotateActivate, displayWidth: 1024 },
          lastPoint: continuationHwnd ? session.lastScreenPoint ?? null : null,
        }, { signal: exec?.signal });
        session.store(result, args.app);
        // LOCAL PATCH P5: app:"explorer" (or any name shared by several
        // processes) used to resolve to an arbitrary process's main window --
        // measured: it returned the desktop shell "Program Manager" instead of
        // any folder window. The kernel now picks over the same visible-window
        // list list_apps uses, prefers the foreground window, and reports how
        // many candidates there were; surface that instead of hiding it.
        const pick = result.window?.pick;
        if (pick && pick.by === 'process' && pick.candidates > 1) {
          result.treeText += `\nWindow pick: ${pick.candidates} windows of process `
            + `${JSON.stringify(result.window.processName)} matched — used `
            + `"${pick.title}"${pick.foreground ? ' (foreground)' : ' (largest area, NOT foreground)'}. `
            + 'Pass hwnd:<n> or pid:<n> to pin one window.';
        } else if (pick && pick.by === 'title') {
          result.treeText += `\nWindow pick: no window of a process named ${JSON.stringify(args.app)}; `
            + `matched the window title instead ("${pick.title}").`;
        }
        // Kernel markers are capture pixels — stored as-is, never rescaled by
        // modelScale (click({marker}) maps them straight through toScreenPoint).
        session.markers = Array.isArray(result.markers) ? result.markers : [];
        let screenshotRef = null;
        if (includeScreenshot && result.screenshot) {
          const attachments = ctx.get('attachments');
          if (attachments) {
            try {
              const refs = await attachments.saveImages([{
                data: Buffer.from(result.screenshot, 'base64'),
                mediaType: 'image/png',
                name: `computer-use-${result.window.processName}-${Date.now()}.png`,
              }]);
              screenshotRef = refs[0] ?? null;
              // The pipeline may downscale the attachment: the model's pixel
              // coordinates live in the attached-image space, so record the
              // exact attached/capture ratio for coordinate conversion.
              if (screenshotRef && Number.isFinite(screenshotRef.width) && Number.isFinite(screenshotRef.height)
                  && result.screenshotWidth > 0) {
                session.modelScale = Math.min(1, Math.max(0.01, screenshotRef.width / result.screenshotWidth));
                // Express tree frames in the same attached-image pixel space the
                // model reads off the screenshot and uses for click x/y.
                result.treeText = scaleTreeFrames(result.treeText, session.modelScale);
                result.treeText +=
                  `\nScreenshot: ${screenshotRef.width}x${screenshotRef.height} px — tree frame=[x,y,w,h] and`
                  + ' click/scroll/drag x/y are all in these attached-image pixels';
              }
            } catch {
              screenshotRef = null; // attachment unavailable: text-only view still works
            }
          }
        }
        if (includeScreenshot && !screenshotRef) {
          result.treeText += '\nScreenshot unavailable — use the accessibility tree only for this observation.';
        }
        // Only the treeText legends leave the tool; markers/lastPointDrawn stay
        // internal (the execute return value must match the output schema).
        if (session.markers.length > 0) {
          result.treeText += GRID_LEGEND;
        }
        if (result.lastPointDrawn === true) {
          result.treeText += LAST_POINT_LEGEND;
        }
        // Truncation is decided by the kernel but must reach the model, or a
        // silently cut tree reads as a complete one.
        if (result.treeWarning) {
          result.treeText += `\nWarning: ${result.treeWarning}`;
        } else if (result.truncated === true) {
          const which = result.truncatedByDepth === true && result.truncatedByNodes === true
            ? 'depth and node'
            : result.truncatedByNodes === true ? 'node' : 'depth';
          result.treeText += `\nTruncated: the ${which} budget cut this tree (depth<=${result.maxDepth ?? requestedMaxDepth},`
            + ` nodes<=${result.maxNodes ?? requestedMaxNodes}, kept ${result.elementCount ?? 0}).`
            + ' Controls beyond it are missing from this snapshot — retry with a larger maxDepth/maxNodes before clicking blind.';
        }
        // A cold Chromium window answers the first UIA query with only its
        // native chrome; the kernel re-walks and keeps the best snapshot. Only
        // report a rebuild when it actually gained something — claiming a
        // rebuild that changed nothing is worse than staying silent.
        const lazyRetries = typeof result.lazyTreeRetries === 'number' ? result.lazyTreeRetries : 0;
        const lazyGained = typeof result.lazyTreeGained === 'number' ? result.lazyTreeGained : 0;
        if (lazyRetries > 0 && result.lazyTreeUnresolved !== true) {
          const firstPass = (result.elementCount ?? 0) - lazyGained;
          result.treeText += `\nNote: the first pass saw only ${firstPass} element(s) — the app had not finished`
            + ` building its accessibility tree. Retried ${lazyRetries}x and gained ${lazyGained};`
            + ' this snapshot is the better of the passes.';
        }
        // State the budgets in use. Without this line a shallow tree and a
        // genuinely sparse app look identical.
        result.treeText += `\nTree budget: depth<=${result.maxDepth ?? requestedMaxDepth},`
          + ` nodes<=${result.maxNodes ?? requestedMaxNodes}`
          + ` (kept ${result.elementCount ?? 0} elements, visited ${result.nodeCount ?? '?'});`
          + ' override per call with maxDepth/maxNodes.';
        // The kernel returns some of these only when it has them; undefined is
        // not lossless JSON and would fail the output snapshot, so omit empties.
        const diagnostics = {};
        for (const [key, value] of [
          ['nodeCount', result.nodeCount],
          ['interactiveCount', result.interactiveCount],
          ['maxSeenDepth', result.maxSeenDepth],
          ['maxDepthUsed', result.maxDepth ?? requestedMaxDepth],
          ['maxNodesUsed', result.maxNodes ?? requestedMaxNodes],
          ['lazyTreeRetries', result.lazyTreeRetries],
          ['lazyTreeGained', result.lazyTreeGained],
        ]) {
          if (typeof value === 'number' && Number.isFinite(value)) diagnostics[key] = value;
        }
        return {
          ok: true,
          window: result.window,
          elementCount: result.elementCount ?? result.elements?.length ?? 0,
          ...diagnostics,
          truncated: result.truncated === true,
          truncatedByDepth: result.truncatedByDepth === true,
          truncatedByNodes: result.truncatedByNodes === true,
          ...result.lazyTreeUnresolved === true ? { lazyTreeUnresolved: true } : {},
          treeText: result.treeText,
          screenshotRef,
        };
      },
      presentCall: () => pendingCall('get_app_state'),
    },

    // ------------------------------------------------------------------- click
    {
      name: 'click',
      description:
        'Click an element (by element_index from the latest get_app_state) or a pixel coordinate in the screenshot. ' +
        'marker (a numbered crosshair id from the latest screenshot grid) takes priority when provided: it clicks the center of the UIA element containing the marker. ' +
        'click_count supports double/triple clicks; mouse_button selects left/right/middle.',
      parameters: {
        app: APP_PARAM,
        click_count: { type: 'integer', description: 'Number of clicks (1..3). Defaults to 1; values outside this range are rejected.' },
        element_index: {
          type: 'integer',
          description: 'Element index from the latest get_app_state snapshot.',
        },
        marker: {
          type: 'string',
          description: 'Marker id from the numbered crosshair grid on the latest get_app_state screenshot (e.g. "D6"). The click snaps to the center of the UIA element containing the marker. Takes priority over element_index and x/y.',
        },
        mouse_button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click. Defaults to left.',
        },
        x: { type: 'number', description: 'X coordinate in screenshot pixel coordinates.' },
        y: { type: 'number', description: 'Y coordinate in screenshot pixel coordinates.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: {
              type: 'string',
              description: 'How the click was delivered: InvokePattern | element | marker-snapped | marker-raw | coordinate. marker-raw means the marker did not land on any UIA element and the raw pixel was clicked.',
            },
            note: { type: 'string' },
            x: { type: 'integer', description: 'Window-relative pixel x of the delivered click (P4: this used to be screen pixels).' },
            y: { type: 'integer', description: 'Window-relative pixel y of the delivered click.' },
            captureX: { type: 'integer', description: 'Window-relative pixel x the click targeted.' },
            captureY: { type: 'integer', description: 'Window-relative pixel y the click targeted.' },
            captureSpace: { type: 'string', description: "Space of captureX/captureY: 'screenshot' when modelScale is 1, else 'window' (they differ by the downscale ratio)." },
            coordinateSpace: { type: 'string', description: "Space of x/y: always 'window'." },
            targetSpace: { type: 'string', description: "Space the caller expressed the target in: 'attached' for x/y and marker ids." },
            snapApplied: { type: 'boolean', description: 'True when a marker click was moved onto a UIA element centre; false when the raw marker/coordinate point was used.' },
            markerId: { type: 'string' },
            snapShift: { type: 'integer', description: 'Pixels the snap moved the click away from the marker. A large value means the marker did not sit on that control.' },
            hostCap: { type: 'integer', description: 'Largest min(width,height) a snap host may have; larger elements are treated as containers.' },
            moveCap: { type: 'integer', description: 'Largest distance a snap may move the click from the marker.' },
            containerNote: { type: 'string', description: 'Why no control was usable at the point, when only containers covered it.' },
            hitLabel: { type: 'string', description: 'Role and name of the element the click was aimed at, when one could be resolved.' },
            hitElementIndex: { type: 'integer' },
            nearbyCount: { type: 'integer', description: 'Number of candidate elements considered around an unsnapped marker.' },
            nearestDistance: { type: 'integer', description: 'Distance in pixels from the clicked point to the nearest reported control.' },
            nearby: {
              type: 'array',
              description: 'Controls nearest an unsnapped marker, closest first, as "role \\"name\\"" with an offset from the clicked point.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  dx: { type: 'integer' },
                  dy: { type: 'integer' },
                  dist: { type: 'integer' },
                  disabled: { type: 'boolean' },
                  index: { type: 'integer' },
                },
              },
            },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        // The model only ever sees these blocks; `value` is for programmatic
        // callers. Coordinates therefore have to be named in the text, an
        // unsnapped marker has to say so, and a snap has to report how far it
        // moved the click — otherwise a guessed pixel, a real hit and a silent
        // 287px slide all look identical in the transcript.
        render: (_args, value) => {
          // x/y and captureX/Y are usually the same window-relative point: with
          // modelScale 1 the screenshot is a 1:1 copy of the window, so both
          // pairs carry identical numbers. Print the point once when the
          // NUMBERS agree, and show both only when the screenshot was
          // downscaled and the pairs actually differ.
          //
          // Do NOT gate this on the space names: coordinateSpace is 'window'
          // while captureSpace is 'screenshot' whenever modelScale is 1, so a
          // name comparison never matches and the receipt repeats itself
          // ("at window (87, 103) = screenshot (87, 103)") — which is exactly
          // the bug this was meant to fix.
          const screenSpace = value.coordinateSpace ?? 'window';
          const captureSpace = value.captureSpace === 'screenshot' ? 'screenshot' : 'window';
          const sameNumbers = value.x != null && value.captureX != null
            && value.x === value.captureX && value.y === value.captureY;
          const where = [];
          if (value.x != null) where.push(`${screenSpace} (${value.x}, ${value.y})`);
          if (value.captureX != null && !sameNumbers) {
            where.push(`${captureSpace} (${value.captureX}, ${value.captureY})`);
          }
          const parts = [`Clicked (${value.via ?? 'coordinate'})`];
          if (value.hitLabel) parts.push(`on ${value.hitLabel}`);
          if (where.length > 0) parts.push(`at ${where.join(' = ')}`);
          if (value.via === 'marker-snapped' && value.snapShift != null && value.snapShift > 0) {
            parts.push(`(snap moved the click ${value.snapShift}px from the marker;`
              + ' if that is not the intended control, click a marker centred on it or use element_index)');
          }
          if (value.via === 'marker-raw') {
            const list = Array.isArray(value.nearby) ? value.nearby : [];
            const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;
            const shown = list.length > 0
              ? list.map((n) => `${n.label}${n.disabled ? ' (disabled)' : ''}`
                + `(${signed(n.dx)},${signed(n.dy)}${n.dist != null ? `, ${n.dist}px` : ''})`).join('; ')
              : 'none';
            parts.push('— NO SNAPPABLE CONTROL under this marker, so the raw pixel was clicked instead'
              + (value.containerNote ? ` (${value.containerNote})` : '')
              + `; nearest controls: ${shown}.`
              + ' Verify with get_app_state, and prefer element_index or a marker sitting on a listed control.');
          } else if (value.note) {
            parts.push(value.note);
          }
          parts.push(REOBSERVE_TEXT);
          return summary(parts);
        },
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'click');
        let targetDesc = `at (${args.x}, ${args.y})`;
        if (args.marker != null) targetDesc = `marker ${args.marker}`;
        else if (args.element_index != null) targetDesc = `element ${args.element_index}`;
        let path = null;
        let identity = null;
        let target = null;
        let kernelPoint = null;   // capture-pixel point for the kernel click x/y
        let snapNote = null;
        // Verdict fields the schema exposes; filled per addressing mode so the
        // render can always state the coordinate space and whether it guessed.
        const verdict = { coordinateSpace: 'window', targetSpace: 'attached' };
        if (args.marker != null) {
          if (!Array.isArray(session.markers) || session.markers.length === 0) {
            throw new Error('click: no grid markers in session — call get_app_state first');
          }
          const marker = session.markers.find((m) => m && String(m.id).toLowerCase() === String(args.marker).toLowerCase());
          if (!marker) {
            throw new Error(
              `click: marker "${args.marker}" is not in the latest grid (${session.markers.length} markers) — ` +
              'call get_app_state first',
            );
          }
          verdict.markerId = String(marker.id);
          // Markers are stored in capture pixels (the kernel click x/y space):
          // never route them through modelCoordinate's modelScale division.
          const snapped = snapMarkerPoint(marker.x, marker.y);
          kernelPoint = snapped.point;
          snapNote = snapped.note;
          verdict.snapApplied = snapped.snapped === true;
          verdict.via = snapped.snapped ? 'marker-snapped' : 'marker-raw';
          verdict.hostCap = snapped.hostCap;
          verdict.moveCap = snapped.moveCap;
          if (snapped.containerNote) verdict.containerNote = snapped.containerNote;
          if (snapped.snapped) {
            if (snapped.label) verdict.hitLabel = snapped.label;
            if (snapped.elementIndex != null) verdict.hitElementIndex = snapped.elementIndex;
            if (typeof snapped.shift === 'number') verdict.snapShift = snapped.shift;
            // P3: carry the identity of the host we snapped onto, so a drifted
            // path cannot silently activate a neighbour.
            const hostElement = session.resolveElement(snapped.elementIndex);
            if (hostElement) identity = elementIdentity(hostElement);
          } else if (snapped.nearby) {
            verdict.nearbyCount = snapped.nearby.total;
            verdict.nearby = snapped.nearby.list.map((n) => ({
              label: n.label,
              dx: n.dx,
              dy: n.dy,
              dist: n.dist,
              ...(n.disabled === true ? { disabled: true } : {}),
              ...(n.index != null ? { index: n.index } : {}),
            }));
            verdict.nearestDistance = snapped.nearby.nearestDistance;
          }
          target = session.toScreenPoint(kernelPoint.x, kernelPoint.y);
        } else if (args.element_index != null) {
          const element = session.requireElement(args.element_index, 'click');
          path = element.path;
          identity = elementIdentity(element);
          target = elementPoint(args.element_index);
          verdict.via = 'element';
          verdict.hitLabel = elementLabel(element);
          verdict.hitElementIndex = args.element_index;
          verdict.snapApplied = true;
        } else if (args.x != null && args.y != null) {
          target = coordinatePoint(args.x, args.y);
          kernelPoint = { x: modelCoordinate(args.x), y: modelCoordinate(args.y) };
          verdict.via = 'coordinate';
          // A bare coordinate is a guess by construction: it is neither an
          // element nor a marker, so report it as unsnapped.
          verdict.snapApplied = false;
        } else {
          throw new Error('click requires either marker, element_index, or both x and y');
        }
        await requireApproval(ctx, exec, 'click', `Click ${targetDesc} in ${args.app}`);
        return runMutation(() => withPointerMotion('click', [target], (motion) => invokePowerShell({
            action: 'click',
            app: args.app,
            path,
            element_identity: identity,
            snapshot_hwnd: session.state?.window?.hwnd ?? null,
            click_count: args.click_count ?? 1,
            mouse_button: args.mouse_button ?? 'left',
            x: kernelPoint ? kernelPoint.x : modelCoordinate(args.x),
            y: kernelPoint ? kernelPoint.y : modelCoordinate(args.y),
            hide_cursor: !motion,
          }, { signal: exec?.signal }).then((result) => {
            // The kernel reports WINDOW pixels in x/y (P4); keep the same point
            // in capture space beside it so one line answers "where did this land".
            const merged = { ...result };
            if (snapNote) merged.note = snapNote;
            // The kernel emits note:null on the plain path (uia.ps1 sets
            // `$note = $null` before the drift check). The schema declares note
            // as a string, so a null here fails output validation with
            // `"value.note" must be a string` — drop it instead.
            if (merged.note == null) delete merged.note;
            // Kernel via names the delivery mechanism; the addressing mode is
            // what the model needs (it distinguishes a snap from a guess).
            if (verdict.via) merged.via = verdict.via;
            if (kernelPoint) {
              merged.captureX = Math.round(kernelPoint.x);
              merged.captureY = Math.round(kernelPoint.y);
            } else if (args.x != null && args.y != null) {
              merged.captureX = Math.round(modelCoordinate(args.x));
              merged.captureY = Math.round(modelCoordinate(args.y));
            }
            if (merged.captureX != null) {
              merged.captureSpace = (session.modelScale && session.modelScale !== 1) ? 'window' : 'screenshot';
            }
            // Every verdict field must be forwarded explicitly: this loop is a
            // whitelist, and a field declared in the schema but missing here is
            // silently never emitted.
            for (const key of [
              'coordinateSpace', 'targetSpace', 'captureSpace', 'snapApplied', 'markerId',
              'hitLabel', 'hitElementIndex', 'nearbyCount', 'nearestDistance', 'snapShift',
              'containerNote', 'hostCap', 'moveCap',
            ]) {
              if (verdict[key] !== undefined) merged[key] = verdict[key];
            }
            if (Array.isArray(verdict.nearby) && verdict.nearby.length > 0) merged.nearby = verdict.nearby;
            // Belt and braces: the output schema is additionalProperties:false
            // and types every field, so a null anywhere in the kernel's reply
            // fails validation for the whole click. Drop nulls rather than
            // ship a result the host will reject.
            for (const key of Object.keys(merged)) {
              if (merged[key] === null) delete merged[key];
            }
            return merged;
          }), { pulse: true, signal: exec?.signal }));
      },
      presentCall: () => pendingCall('click'),
    },

    // -------------------------------------------------- perform_secondary_action
    {
      name: 'perform_secondary_action',
      description:
        'Invoke a secondary accessibility action exposed by an element (from the Secondary Actions list in get_app_state, e.g. Invoke, Toggle, ExpandCollapse, SelectionItem, ScrollItem).',
      parameters: {
        app: APP_PARAM,
        element_index: { type: 'integer', required: true, description: 'Element identifier from the latest get_app_state.' },
        action: { type: 'string', required: true, description: 'Secondary accessibility action name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            error: { type: 'string' },
            note: { type: 'string' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Performed secondary action via ${value.via ?? '?'}`, value.error ? `(${value.error})` : '', REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'perform_secondary_action');
        const element = session.requireElement(args.element_index, 'perform_secondary_action');
        const path = element.path;
        const identity = elementIdentity(element);
        await requireApproval(ctx, exec, 'perform_secondary_action', `Perform ${args.action} on element ${args.element_index} in ${args.app}`);
        return runMutation(() => withPointerMotion('perform_secondary_action', [elementPoint(args.element_index)], () => invokePowerShell({
          action: 'perform_secondary_action',
          app: args.app,
          path,
          element_identity: identity,
          snapshot_hwnd: session.state?.window?.hwnd ?? null,
          secondary_action: args.action,
        }, { signal: exec?.signal }), { pulse: false, signal: exec?.signal }));
      },
    },

    // --------------------------------------------------------------- set_value
    {
      name: 'set_value',
      description:
        'Set the value of a settable accessibility element (a text field, search box, etc.). Uses the ValuePattern when available, otherwise focuses the element and replaces its text.',
      parameters: {
        app: APP_PARAM,
        element_index: { type: 'integer', required: true, description: 'Element identifier from the latest get_app_state.' },
        value: { type: 'string', required: true, description: 'Value to assign.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Set value via ${value.via ?? '?'}`, REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'set_value');
        const setValueElement = session.requireElement(args.element_index, 'set_value');
        const path = setValueElement.path;
        const identity = elementIdentity(setValueElement);
        await requireApproval(ctx, exec, 'set_value', `Set value of element ${args.element_index} in ${args.app}`);
        return runMutation(() => withPointerMotion('set_value', [elementPoint(args.element_index)], () => invokePowerShell({
          action: 'set_value', app: args.app, path, element_identity: identity, value: args.value, snapshot_hwnd: session.state?.window?.hwnd ?? null,
        }, { signal: exec?.signal }), { pulse: false, signal: exec?.signal }));
      },
    },

    // ------------------------------------------------------------ select_text
    {
      name: 'select_text',
      description:
        'Select text inside a text element, or place the text cursor before or after it. Provide text exactly as it appears in the accessibility tree. If the text is not unique, provide surrounding prefix or suffix text to disambiguate it.',
      parameters: {
        app: APP_PARAM,
        element_index: { type: 'integer', required: true, description: 'Text element identifier from the latest get_app_state.' },
        text: { type: 'string', required: true, description: 'Target text as shown in the accessibility tree.' },
        prefix: { type: 'string', description: 'Optional text immediately before the target, used to disambiguate repeated matches.' },
        suffix: { type: 'string', description: 'Optional text immediately after the target, used to disambiguate repeated matches.' },
        selection: {
          type: 'string',
          enum: ['text', 'cursor_before', 'cursor_after'],
          description: 'Whether to select the text or place the cursor before or after it. Defaults to text.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            selection: { type: 'string' },
            note: { type: 'string' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Selected text via ${value.via ?? '?'}`, value.note ? `(${value.note})` : '', REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'select_text');
        const selectElement = session.requireElement(args.element_index, 'select_text');
        const path = selectElement.path;
        const identity = elementIdentity(selectElement);
        await requireApproval(ctx, exec, 'select_text', `Select "${args.text}" in element ${args.element_index} of ${args.app}`);
        return runMutation(() => withPointerMotion('select_text', [elementPoint(args.element_index)], () => invokePowerShell({
            action: 'select_text',
            app: args.app,
            path,
            element_identity: identity,
            snapshot_hwnd: session.state?.window?.hwnd ?? null,
            text: args.text,
            prefix: args.prefix,
            suffix: args.suffix,
            selection: args.selection ?? 'text',
          }, { signal: exec?.signal }), { pulse: false, signal: exec?.signal }));
      },
    },

    // ----------------------------------------------------------------- scroll
    {
      name: 'scroll',
      description:
        'Scroll an element in a direction by a number of pages. Coordinates (x/y) are screenshot pixels. Element-centered scrolling is preferred when an element_index is provided.',
      parameters: {
        app: APP_PARAM,
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          required: true,
          description: 'Scroll direction.',
        },
        element_index: { type: 'integer', description: 'Element to scroll (uses its center).' },
        pages: { type: 'number', description: 'Number of pages to scroll (greater than 0, at most 10). Fractional values supported. Defaults to 1.' },
        x: { type: 'number', description: 'Optional X screenshot coordinate for the scroll target.' },
        y: { type: 'number', description: 'Optional Y screenshot coordinate for the scroll target.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            direction: { type: 'string' },
            pages: { type: 'number' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Scrolled ${value.direction ?? ''}`, value.pages != null ? `${value.pages} pages` : '', `(${value.via ?? 'mouse wheel'})`, REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'scroll');
        let path = null;
        let identity = null;
        if (args.element_index != null) {
          const scrollElement = session.requireElement(args.element_index, 'scroll');
          path = scrollElement.path;
          identity = elementIdentity(scrollElement);
        }
        const target = elementPoint(args.element_index)
          ?? coordinatePoint(args.x, args.y)
          ?? session.windowScreenPoint();
        await requireApproval(ctx, exec, 'scroll', `Scroll ${args.direction} in ${args.app}`);
        return runMutation(() => withPointerMotion('scroll', [target], (motion) => invokePowerShell({
            action: 'scroll',
            app: args.app,
            path,
            element_identity: identity,
            snapshot_hwnd: session.state?.window?.hwnd ?? null,
            direction: args.direction,
            pages: args.pages ?? 1,
            x: modelCoordinate(args.x),
            y: modelCoordinate(args.y),
            hide_cursor: !motion,
          }, { signal: exec?.signal }), { pulse: false, signal: exec?.signal }));
      },
    },

    // ------------------------------------------------------------------ drag
    {
      name: 'drag',
      description:
        'Drag from one point to another using screenshot pixel coordinates (from_x/from_y to to_x/to_y).',
      parameters: {
        app: APP_PARAM,
        from_x: { type: 'number', required: true, description: 'Start X coordinate in screenshot pixels.' },
        from_y: { type: 'number', required: true, description: 'Start Y coordinate in screenshot pixels.' },
        to_x: { type: 'number', required: true, description: 'End X coordinate in screenshot pixels.' },
        to_y: { type: 'number', required: true, description: 'End Y coordinate in screenshot pixels.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Dragged via ${value.via ?? 'mouse_event'}`, REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'drag');
        await requireApproval(ctx, exec, 'drag', `Drag in ${args.app} from (${args.from_x}, ${args.from_y}) to (${args.to_x}, ${args.to_y})`);
        const dragStart = coordinatePoint(args.from_x, args.from_y);
        const dragEnd = coordinatePoint(args.to_x, args.to_y);
        return runMutation(() => withPointerMotion('drag', [dragStart, dragEnd], (motion) => invokePowerShell({
            action: 'drag',
            app: args.app,
            snapshot_hwnd: session.state?.window?.hwnd ?? null,
            from_x: modelCoordinate(args.from_x),
            from_y: modelCoordinate(args.from_y),
            to_x: modelCoordinate(args.to_x),
            to_y: modelCoordinate(args.to_y),
            hide_cursor: !motion,
          }, { signal: exec?.signal }), { pulse: false, interactionIndex: 1, signal: exec?.signal }));
      },
    },

    // -------------------------------------------------------------- press_key
    {
      name: 'press_key',
      description:
        'Press a key or key-combination on the keyboard, including modifier and navigation keys. Supports xdotool `key` syntax, for example `a`, `Return`, `Tab`, `super+c` (Ctrl+C on Windows), `Up`, `Page_Up`, `F5`, `KP_0`.',
      parameters: {
        app: APP_PARAM,
        key: { type: 'string', required: true, description: 'Key or key combination to press (xdotool syntax).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            key: { type: 'string' },
            events: { type: 'integer' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Pressed ${value.key ?? ''}`, REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'press_key');
        await requireApproval(ctx, exec, 'press_key', `Press ${args.key} in ${args.app}`);
        return runMutation(() => invokePowerShell({
          action: 'press_key', app: args.app, key: args.key,
          snapshot_hwnd: session.state?.window?.hwnd ?? null,
        }, { signal: exec?.signal }));
      },
    },

    // -------------------------------------------------------------- type_text
    {
      name: 'type_text',
      description:
        'Type literal text using keyboard input into the focused control of the target app. Uses clipboard paste for Unicode reliability and restores the previous clipboard content afterwards.',
      parameters: {
        app: APP_PARAM,
        text: { type: 'string', required: true, description: 'Literal text to type.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            via: { type: 'string' },
            ...OBSERVATION_REQUIRED_PROPERTY,
          },
        },
        render: (_args, value) => summary([`Typed ${JSON.stringify(_args.text)} via ${value.via ?? 'clipboard'}`, REOBSERVE_TEXT]),
      },
      async execute(args, exec) {
        requireFreshSnapshot(args.app, 'type_text');
        await requireApproval(ctx, exec, 'type_text', `Type ${JSON.stringify(args.text)} into ${args.app}`);
        return runMutation(() => invokePowerShell({
          action: 'type_text', app: args.app, text: args.text,
          snapshot_hwnd: session.state?.window?.hwnd ?? null,
        }, { signal: exec?.signal }));
      },
    },
  ].map(defineTool).map(withAudit);
}
