// tool-surface.js — the ONE place that states how many tools this plugin exposes.
//
// Why a constant instead of the literal 10 scattered across the test suite:
// the official Codex surface is 10 methods, and four tests asserted that number
// directly. When local patch P21 added `check_screen_change` (a probe that is
// deliberately NOT part of the official surface), every one of those assertions
// went red even though nothing was broken — the tests were pinning a snapshot,
// not a property. A named constant keeps the intent readable and makes the next
// addition a one-line change instead of a four-file grep.

/** The ten official Codex Computer Use methods. Must stay exactly these ten. */
export const OFFICIAL_TOOL_NAMES = Object.freeze([
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'set_value',
  'select_text',
  'scroll',
  'drag',
  'press_key',
  'type_text',
]);

/** Local additions that are NOT part of the official surface. */
export const LOCAL_TOOL_NAMES = Object.freeze([
  // P21: ~100 ms pixel probe used to skip a ~800 ms get_app_state when nothing
  // on screen moved. Carries no tree and no coordinates, so it can never verify
  // an action — it only advises whether re-observing is worth the cost.
  'check_screen_change',
]);

/** Everything the plugin registers, official first. */
export const ALL_TOOL_NAMES = Object.freeze([...OFFICIAL_TOOL_NAMES, ...LOCAL_TOOL_NAMES]);
