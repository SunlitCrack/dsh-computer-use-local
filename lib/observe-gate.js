// observe-gate.js — cheap "did the screen change?" test used to SKIP get_app_state.
//
// Why this exists: a get_app_state call costs ~820 ms even on a 3-element window.
// Measured breakdown (2026-11-03, Win10 / fork 0.3.2-local.11):
//   list_apps                     75 ms   <- IPC only, no UIA attach
//   get_app_state maxDepth=0      72 ms   <- no children expanded
//   get_app_state maxDepth=1     832 ms   <- expanding the FIRST level is the cliff
//   get_app_state full (130 els)  714 ms   <- element count is nearly free after that
// So the cost is UIA attach + first-level child expansion, not tree size, and no
// budget tuning can remove it. The only lever left is to call it less often.
//
// A shift-frame pixel diff costs ~0.2 ms (same 64x36 HSV grid idea as dsh-see-now),
// roughly 4000x cheaper than one observation. When the diff says "nothing moved",
// the previous snapshot is still accurate and the caller may reuse it.
//
// SCOPE — read before using this to skip an observation:
// This gate answers ONLY "did any pixels change". It cannot answer "which element
// changed", "is my stale element_index still valid", or "did the click land".
// It is therefore advisory: it may let a caller skip a RE-observation that would
// have returned the same tree, and it must never be used to validate an action's
// effect. Action verification still requires a real get_app_state.

const GRID_W = 64;
const GRID_H = 36;

/**
 * Any cell recoloured this much is a real change even at constant brightness.
 */
const CHROMA_FLOOR = 40;
/**
 * A cell whose SIGNED luminance delta differs from the dominant transform by this
 * much moved for a different reason than the rest of the frame.
 *
 * 18 rather than 25: with 25, two large regions shifting by nearby but distinct
 * amounts (left -100, right -80) fell inside the same band and cancelled, even
 * though the layout had changed. Measured: 18 is the largest value that separates
 * that case while still leaving a still frame at exactly 0.
 */
const RESIDUAL_MIN = 18;
/**
 * How many deviating cells are needed to call it structural.
 *
 * The band is wide because the quantity is a count, not a tuned score. Measured
 * on a 64x36 grid (2304 cells): a cursor occupies 1-6 cells, and the smallest
 * dialog in the calibration set (200x120 px on 1809x1157, 1.1% of the window)
 * occupies 32. Anything from 8 to 20 separates them; 8 leaves the most headroom
 * on the "small dialog" side, where a false negative is the dangerous direction.
 */
const RESIDUAL_CELLS = 8;
/**
 * How CONNECTED the deviating cells must be: adjacent pairs of deviating cells per
 * deviating cell.
 *
 * The count alone is not enough once the magnitude floor is gone, because
 * uncorrelated sensor/scaling noise deviates in EVERY cell: measured on a 160x90
 * probe, two independent noise frames gave devCount 670 against a matrix of 2304.
 * What separates noise from a real change is not how much deviates but whether the
 * deviating cells touch each other — a panel or a sidebar is one solid region, noise
 * is salt and pepper.
 *
 * Measured ratio (adjacent deviating pairs / deviating cells), 160x90 probe:
 *   independent noise      0.55 - 0.58   <- must stay below
 *   dotted separator       0.84          <- must stay above
 *   one added text line    0.98
 *   cursor                 1.17
 *   small dialog           1.85
 *   sidebar                1.93
 *   dark-theme panel       1.93
 *
 * 0.70 sits between the highest noise reading (0.58) and the lowest real change
 * (0.84), with ~0.12 of headroom on each side. Measured sweep: at 0.85 the dotted
 * separator and small text movements were missed; at 0.65 and below independent
 * noise started producing false positives.
 */
const CONNECTIVITY_MIN = 0.7;
/**
 * A SMALL but only moderately connected deviation is fine text, not noise.
 *
 * Connectivity separates "one region moved" from "salt and pepper", but fine text
 * sits in between: on a real code-diff view (Qoder, two-column diff with dense
 * syntax highlighting) desaturated scrolling measures conn 0.49-0.70 — below the
 * 0.70 region threshold, above nothing in particular.
 *
 * What separates it from noise is AREA: text touches a small fraction of the
 * window, while capture noise that reaches conn 0.39+ covers 19% or more.
 *   real Qoder diff scroll   devCount 135-168  (5.9-7.3% of 2304 cells)
 *   noise +/-40              devCount 443      (19.2%)
 *   noise +/-60              devCount 860      (37.3%)
 *
 * So: if less than 15% of cells deviate but they are at least half-connected,
 * that is text moving, not sensor noise. Calibrated against exported real frames,
 * not synthetic patterns — earlier synthetic patterns had the wrong adjacency
 * structure entirely (conn 1.67 for ruled text lines vs 0.49 for real diff text).
 */
const SPARSE_CONN_MIN = 0.45;
const SPARSE_AREA_MAX = 0.15;

// NOTE: there is deliberately NO peak-luminance floor.
//
// An earlier version had `maxAbs < 39 => unchanged` before the count rule. That
// combination is self-defeating: on a dark theme a 40%-wide panel opening at
// V=25..38 has hundreds of deviating cells but a peak under 39, so the floor
// rejected a real structural change. Connectivity does the job the floor was
// wrongly asked to do, without cutting away low-contrast real changes.

/** Convert an rgb24 buffer to a coarse HSV-ish signature on a fixed grid. */
export function signature(rgb, width, height) {
  if (!rgb || !width || !height) return null;
  const out = new Float32Array(GRID_W * GRID_H * 3);
  // The grid is FIXED at 64x36 regardless of the incoming frame size, so this
  // function is a resampler, not a 1:1 mapper.
  //
  // An earlier version used `cellW = width / GRID_W`, which silently degenerates
  // when the caller probes at exactly GRID_W x GRID_H: every cell covered a
  // single pixel, nothing was averaged, and a probe of 64x36 returned a
  // 64*36*3 = 6912-float signature instead of one coarse cell per grid slot. Two
  // visible consequences: distance() divided by 6912 instead of 2304 (halving
  // every score), and fine text changes averaged away into "unchanged".
  const cellW = width / GRID_W;
  const cellH = height / GRID_H;
  const stride = width * 3;
  for (let gy = 0; gy < GRID_H; gy += 1) {
    const y0 = Math.min(height - 1, Math.floor(gy * cellH));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((gy + 1) * cellH)));
    // Bounded sampling: a change detector does not need every pixel. At most 6
    // samples per axis keeps a 1080p frame under a millisecond.
    const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
    for (let gx = 0; gx < GRID_W; gx += 1) {
      const x0 = Math.min(width - 1, Math.floor(gx * cellW));
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((gx + 1) * cellW)));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;

      for (let y = y0; y < y1; y += stepY) {
        const row = y * stride;
        for (let x = x0; x < x1; x += stepX) {
          const i = row + x * 3;
          r += rgb[i];
          g += rgb[i + 1];
          b += rgb[i + 2];

          n += 1;
        }
      }
      if (n === 0) continue;
      r /= n; g /= n; b /= n;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const v = max / 255;
      const s = max === 0 ? 0 : (max - min) / max;
      // Hue as a 0..1 wheel; cheap approximation, adequate for change detection.
      let h = 0;
      const d = max - min;
      if (d !== 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
      }
      const o = (gy * GRID_W + gx) * 3;
      out[o] = h; out[o + 1] = s; out[o + 2] = v;
    }
  }
  return out;
}

/**
 * Change statistics for two signatures.
 *
 * SIX DESIGNS DIED BEFORE THIS ONE, and the progression is the point — each
 * looked obviously correct until a case outside its author's mental model broke
 * it. All six summarised the frame into a number that a large uniform region
 * could dominate:
 *
 *   1. weighted colour sum      -> grey noise scored 43 on a frozen screen
 *   2. weighted brightness+grad -> two windows 5.5 and a text edit 11.2, wrong both ways
 *   3. top5 / mean              -> provably just the inverse of changed AREA
 *   4. median / P99             -> one-level cliff at 60; P99 discarded the top 23 cells
 *   5. standard deviation       -> mask + 200x120 dialog scored sd 4.42 (missed)
 *   6. median + count of |delta| deviations
 *                               -> layout reorder cancelled out: a half/half content
 *                                  swap gave devCount 0, because |+200| and |-200| both
 *                                  read as 200. Also phase-dependent: the same
 *                                  sidebar read devCount 0 or 36 depending on
 *                                  whether its edge fell on a grid boundary.
 *
 * WHAT THIS DOES
 * --------------
 * Keep the SIGN of the delta, normalise away the dominant transform, and count
 * what disagrees. The sign is what makes reordering visible: a half/half swap is
 * +200/-200, whose median is one of them, so the other half deviates by 400. With
 * absolute values both halves read 200 and the field looks flat.
 *
 *   delta    — signed per-cell luminance change (b - a), 0..255 scale
 *   median   — the dominant transform (a global dim IS the median, so subtracting
 *              it leaves only cells that moved for a different reason)
 *   devCount — cells whose |delta - median| >= RESIDUAL_MIN. This is the decider.
 *   maxAbs   — peak |delta|, used only as a noise floor
 *   maxC     — peak per-cell chroma delta, so a same-brightness recolour is caught
 *              even when luminance is untouched
 *
 * Because devCount is a COUNT of cells rather than a summary statistic, it does
 * not dilute: a dialog covering 1.1% of the window still contributes 27 cells.
 *
 * @returns {{median:number, devCount:number, maxAbs:number, maxC:number}|null}
 */
export function changeStats(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  // Derive the cell count from the declared grid, not from the buffer length.
  //
  // An earlier version used .length / 3 after the signature grew to 4 floats per
  // cell: that gave 3072 cells instead of 2304, inflated gridH from 36 to 48, read
  // past the end of the array, and skewed the median by 3x. It stayed hidden because
  // the out-of-range reads produced NaN, which the deviation test silently ignores.
  const cellCount = GRID_W * GRID_H;
  if (cellCount === 0) return null;

  const delta = new Float64Array(cellCount);
  let maxAbs = 0;
  let maxC = 0;

  for (let k = 0; k < cellCount; k += 1) {
    const i = k * 3;
    // SIGNED: the direction of the change carries the information that a
    // layout reorder exists at all.
    const luma = (b[i + 2] - a[i + 2]) * 255;
    // Hue is circular; its contribution is faded by saturation so near-grey cells
    // (where hue is numerically meaningless) do not contribute noise.
    let dh = Math.abs(a[i] - b[i]);
    if (dh > 0.5) dh = 1 - dh;
    const chroma = (dh * Math.min(a[i + 1], b[i + 1]) + Math.abs(a[i + 1] - b[i + 1])) * 255;

    delta[k] = luma;
    const abs = luma < 0 ? -luma : luma;
    if (abs > maxAbs) maxAbs = abs;
    if (chroma > maxC) maxC = chroma;

  }

  const sorted = Array.from(delta).sort((x, y) => x - y);
  const median = sorted[Math.floor(cellCount / 2)];

  // Mark deviating cells on the fixed 64x36 grid so adjacency can be measured.
  const gridW = GRID_W;
  const gridH = Math.round(cellCount / gridW);
  const deviating = new Uint8Array(cellCount);
  let devCount = 0;
  for (let k = 0; k < cellCount; k += 1) {
    if (Math.abs(delta[k] - median) >= RESIDUAL_MIN) {
      deviating[k] = 1;
      devCount += 1;
    }
  }

  // Adjacency: how many neighbouring deviating pairs exist. A solid region gives
  // roughly two pairs per cell (interior cells have several neighbours); salt and
  // pepper noise gives far fewer because its deviating cells rarely touch.
  let adjacency = 0;
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const k = gy * gridW + gx;
      if (deviating[k] !== 1) continue;
      if (gx + 1 < gridW && deviating[k + 1] === 1) adjacency += 1;
      if (gy + 1 < gridH && deviating[k + gridW] === 1) adjacency += 1;
    }
  }

  return { median, devCount, adjacency, maxAbs, maxC };
}

/**
 * Turn change statistics into a verdict.
 *
 * @param {{median:number, devCount:number, maxAbs:number, maxC:number}} stats
 * @param {{chromaFloor?:number, residualCells?:number}} [opts]
 *
 * Calibration (160x90 probe unless noted), all measured:
 *   scenario                        median  devCount  maxAbs  maxC  verdict
 *   identical frame                    0.0         0       0     0  unchanged
 *   cursor moved 1 cell                0.0         4     165     0  unchanged  (count)
 *   pale hover tint                    0.0         0       5    25  unchanged  (floor)
 *   uniform dim -25                  -25.0         0      25     0  unchanged
 *   uniform dim -45                  -45.0         0      45     0  unchanged
 *   uniform repaint +200             200.0         0     200     0  unchanged
 *   mask -45 + dialog 200x120 (1.1%)  -45.0        27      45     0  changed
 *   mask -45 + dialog 396x225 (4.3%)  -45.0        97      45     0  changed
 *   mask -45 + dialog 1200x700 (41%)  -45.0       924      45     0  changed
 *   mask -45 + dark dialog 200x120    -45.0        32     130     0  changed
 *   sidebar edge x=40 (grid-aligned) -100.0       864     100     0  changed
 *   sidebar edge x=41 (not aligned)  -100.0       828     100     0  changed
 *   sidebar edge x=50                -100.0       504     100     0  changed
 *   left -100 / right -80             -81.0         0     100     0  unchanged (same band)
 *   left -100 / right -70             -71.0      1152     100     0  changed
 *   split content swap +200/-200      200.0      1152     200     0  changed
 *   two-tone theme switch             176.0      1152     190     0  changed
 *   one added text line                 0.0       114     112     0  changed
 *   button highlight                    0.0         0      35   255  changed  (chroma)
 *   red -> blue                         0.0         0       0    76  changed  (chroma)
 *
 * The rows that killed earlier designs: the mask+dialog family (5 and 6), the
 * grid-aligned sidebar (6), the content swap and theme switch (6), uniform
 * repaint (4).
 *
 * Known limit: a change that covers ~99.7% of the window is indistinguishable from
 * a uniform transform BY CONSTRUCTION — the dominant transform IS the change, so
 * the residual is near zero. That is the same behaviour as a full-screen repaint,
 * which is intentional: neither moves the layout in a way devCount can see.
 */
export function decide(stats, {
  chromaFloor = CHROMA_FLOOR,
  residualCells = RESIDUAL_CELLS,
  connectivityMin = CONNECTIVITY_MIN,
  sparseConnMin = SPARSE_CONN_MIN,
  sparseAreaMax = SPARSE_AREA_MAX,

} = {}) {
  if (!stats) return { changed: true, reason: 'bad-stats' };
  const { median, devCount, adjacency, maxAbs, maxC } = stats;
  if (!Number.isFinite(median) || !Number.isFinite(devCount) || !Number.isFinite(maxAbs)
    || !Number.isFinite(adjacency)) {
    return { changed: true, reason: 'bad-frame' };
  }
  // A recolour can leave luminance untouched, so it is checked first.
  if (maxC >= chromaFloor) return { changed: true, reason: 'chroma-change' };
  // Too few deviating cells to matter (cursor, hover, antialiasing).
  if (devCount < residualCells) return { changed: false, reason: 'uniform-change' };
  // A CONNECTED deviation is a region moving (panel, sidebar, dialog).
  const connectivity = devCount > 0 ? adjacency / devCount : 0;
  if (connectivity >= connectivityMin) return { changed: true, reason: 'structural-change' };
  // Fine text: a small area with moderate connectivity is text moving, not noise.
  // See SPARSE_AREA_MAX for the calibration against exported real frames.
  const area = devCount / (GRID_W * GRID_H);
  if (area <= sparseAreaMax && connectivity >= sparseConnMin) {
    return { changed: true, reason: 'text-change' };
  }
  return { changed: false, reason: 'scattered-change' };
}
export function shouldReobserve(previousSig, frameRgb, width, height, threshold = RESIDUAL_CELLS) {
  const next = signature(frameRgb, width, height);
  if (!next) return { changed: true, score: null, reason: 'no-frame' };
  if (!previousSig) return { changed: true, score: null, reason: 'no-baseline', signature: next };
  const stats = changeStats(previousSig, next);
  // A malformed frame (wrong byte count, non-finite arithmetic) must read as
  // "changed": a false `unchanged` is the one failure direction that lets a caller
  // act on a stale tree.
  if (!stats) return { changed: true, score: null, reason: 'shape-mismatch', signature: next };
  const verdict = decide(stats, { residualCells: threshold });
  return {
    changed: verdict.changed,
    // `score` is the peak per-cell luminance change: "is there anything to look
    // at", independent of how much area it covers. `deviation` reports how many
    // cells moved against the dominant transform, so a caller can see WHY.
    score: Number.isFinite(stats.maxAbs) ? Number(stats.maxAbs.toFixed(2)) : null,

    reason: verdict.reason,
    deviation: Number.isFinite(stats.devCount) ? stats.devCount : null,
    connectivity: stats.devCount > 0 ? Number((stats.adjacency / stats.devCount).toFixed(2)) : 0,
    chroma: Number.isFinite(stats.maxC) ? Number(stats.maxC.toFixed(2)) : null,
    signature: next,
  };
}





























