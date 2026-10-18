# Upstream report (withdrawn from GitHub)

This is the exact text of the defect report I filed against
`mekos2772/dsh-computer-use` on 2026-10-18, kept here because the issue was
**closed as not planned** — the upstream repository has had no push since
2026-09-29 (`b85ecf2`), so the report is preserved for the record / for reuse
if upstream ever resumes.

- Issue: https://github.com/mekos2772/dsh-computer-use/issues/1 (CLOSED, NOT_PLANNED)
- Fix branch: `fix/windows-five-defects` (this branch)

---

Thanks for the plugin — the kernel design (resident PowerShell + JSON lines, element-first, forced re-observation) holds up well. I ran it as the primary computer-use provider in DeepSeek Harness for a day on a Chinese-locale Windows box and hit five defects worth reporting. All five are reproduced and fixed in a fork branch, linked at the bottom.

## Environment

- Windows 10 19045, 1920x1080 @125%, `powershell.exe` 5.1 (system codepage cp936)
- plugin `@milkuovo/dsh-computer-use@0.3.1` (git `b85ecf2`), used as a cordis plugin in DSH 0.2.1-rc.2
- also reproduced against the standalone MCP mode (`node mcp-server.mjs`), so it is the kernel, not the host

## Summary

| # | Area | Effect |
|---|---|---|
| 1 | `lib/uia.ps1` header | non-ASCII `type_text` / `set_value` arrive mojibaked (`验收` -> `楠屾敹`) |
| 2 | `GetWindowTextW` P/Invoke | non-ASCII window titles are mojibaked and truncated to ~half (`评估 Computer-use … ` -> `膵0O `) |
| 3 | element addressing by path | after any re-render the same path addresses a **neighbour** and the call still reports success |
| 4 | click receipt | `x/y` are screen pixels while the rest of the surface is window-relative; `InvokePattern` moves no pointer at all |
| 5 | `Resolve-Window` by app name | picks an arbitrary process's main window (`app:"explorer"` returns the desktop shell) |

## 1. stdin is decoded with the console codepage

`lib/uia.ps1` pins only the output side:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

`[Console]::In` therefore decodes with the console input codepage (cp936 here). The Node side writes UTF-8, so any non-ASCII payload is mangled before it is used: `type_text("中文验收")` lands as `楠屾敹`, which is exactly "UTF-8 bytes read as GBK". ASCII-only sessions never notice.

Fix: `try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }` next to the output lines.

## 2. `GetWindowTextW` marshals the StringBuilder as ANSI

```csharp
[DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
```

Without `CharSet`, `StringBuilder` is marshalled as ANSI, so the UTF-16 written by the W-function is read back as single bytes. Consequences: `list_apps` titles are mojibaked, and because `GetWindowTextLengthW` returns a **character** count while the buffer is sized for ANSI bytes, titles are also cut to roughly half. Compare with `get_app_state`, which reads titles through UIA and is correct.

Fix: `[DllImport("user32.dll", CharSet = CharSet.Unicode)]`.

## 3. Positional element paths address a neighbour after a re-render

`elements[].path` is a chain of child ordinals and `Resolve-ElementByPath` replays it. Any window that rebuilds its children between the snapshot and the action (Explorer's shell view is the easy case) makes the same path land on a different element — and the action reports success.

Measured: `click(element_index: 46)` in an Explorer window; the tree printed element 46 as `dsh-purge-适配-harness…` and element 48 as `插件配置卡片在哪…`; the click **opened the element 48 file** (Obsidian was launched with the wrong note). Nothing in the receipt indicated a mismatch.

Suggestion: record an identity with the snapshot (`AutomationId`, `Name`, `ControlType`) and verify it before acting; when the path drifted, re-find the element by identity and say so in the receipt; when the element is really gone, fail loudly instead of acting on whatever now sits at those ordinals.

Related: the automation root is captured **before** activation, which is a reasonable trade to dodge Chromium's mid-activation `FromHandle` flakiness — but Explorer rebuilds its view on the foreground change, so that root goes stale and the identity re-search then walks an empty tree. Re-acquiring the root right after a successful activation (keeping the old one if the provider refuses) fixes it.

## 4. click receipt reports screen pixels

```powershell
$elCenter = @{ x = [int]($r.X - $rect.x) + ...; y = ... }   # window-relative
$ptS = & $toScreen $elCenter.x $elCenter.y
return @{ ...; x = $ptS.x; y = $ptS.y }                      # screen pixels
```

In a 1301x782 window, clicking element 48 reported `(1259, 860)` — outside the window, and confusing because tree `frame=[x,y,w,h]`, grid markers and the `click` `x/y` **inputs** are all window-relative. On the `InvokePattern` path no pointer moves at all, so the coordinates describe nothing that happened.

Suggestion: report window-relative `x/y` (matching the amber last-point ring) and state in the note that a `InvokePattern` click moved no pointer.

## 5. `Resolve-Window` picks an arbitrary process window

```powershell
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and ($_.ProcessName -eq $app ...) }
if ($procs) { return $procs[0].MainWindowHandle }
```

`$procs[0]` is "some process with that name". With two Explorer processes, `app:"explorer"` returned the desktop shell (`Program Manager`, hwnd 65748) instead of either folder window; and a just-launched app whose `MainWindowHandle` was still zero produced `target window not found: 'notepad'` while `list_apps` had just listed it.

Suggestion: select over the same enumeration `list_apps` uses (`ListVisibleWindows`), skip the shell desktop windows (`Progman`/`WorkerW`/`Program Manager`), prefer the foreground window, else the largest area, then fall back to a title match — and report the decision (`by`, `candidates`, `ambiguous`) so an ambiguous name is visible instead of silently wrong.

## Verification

Both harnesses are in this branch and speak the kernel's JSON-line protocol directly (no host needed):

```
node scripts/local-repro.mjs  --title <window title substring>   # list_apps, name resolution, index map
node scripts/local-verify.mjs --title <window title substring>   # 6 assertions against a live desktop
```

Last run on the environment above, against a small Explorer folder:

```
PASS  app-name resolves to a real app window (not the desktop shell)   pick: candidates=2 ambiguous=true
PASS  stdin UTF-8 round trip (CJK survives)                            "unicode 验收 42"
PASS  identity wins over a drifted path                                identity-recovered-from-drift
PASS  plain path route still works                                     SelectionItemPattern
PASS  stale path fails loudly                                          path '9.9.9.9' no longer resolves
PASS  receipt x/y are window-relative (inside bounds)                  (1144, 19) vs 1301x782
SUMMARY: 6/6 passed
```
