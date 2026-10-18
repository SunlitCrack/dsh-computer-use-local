# 本地补丁（fork 自 npm `@milkuovo/dsh-computer-use@0.3.1`）

这份 fork 只做一件事：把本机实测到的 5 个缺陷修掉。上游代码结构、工具面（10 个工具）、
配置项、cordis 装配方式都没动，所以它仍然是「一个 DSH 插件 + 一份 cordis patch」。

- 基线：git `b85ecf2`（`release: 0.3.1`），npm 0.3.1
- 生成方式：`git diff > LOCAL-PATCHES.diff`（该文件与本说明一起留在工作区，未提交）
- 验证脚本：`node scripts/local-verify.mjs --title <窗口标题片段>`（需要真实桌面会话）
- 复现脚本：`node scripts/local-repro.mjs --title <窗口标题片段>`（打印 list_apps / 名字解析 / 索引映射）

| # | 位置 | 症状（本机实测） | 修法 |
|---|---|---|---|
| P1 | `lib/uia.ps1` 头部 | 只有 `[Console]::OutputEncoding` 被设成 UTF-8，`InputEncoding` 没设。Node 发来的 UTF-8 JSON 被按系统代码页（本机 cp936）解码，**任何非 ASCII 的 `type_text` / `set_value` 都变乱码**：`验收` → `楠屾敹` | 补 `[Console]::InputEncoding = UTF8` |
| P2 | `lib/uia.ps1` C# 声明 | `GetWindowTextW(..., StringBuilder, int)` 未指定 `CharSet`，StringBuilder 按 ANSI 封送，UTF-16 被当单字节读回：`评估 Computer-use 插件需求 — DeepSeek Harness` → `膵0O `，`亚洲之子v89…` → `歂2mKNP[v`，且长度被截半（`GetWindowTextLengthW` 给的是字符数） | 加 `CharSet = CharSet.Unicode` |
| P3 | `lib/uia.ps1` 元素寻址 + `lib/tools.js` | 元素靠 **位置路径**（子序号链）寻址。窗口一重排（Explorer/Chromium 会重建视图），同一条路径就落到**邻居**上，**调用却返回成功**：实测点 `element_index 46`（`dsh-purge-适配-harness…`）实际激活了树里编号 48 的那篇（Obsidian 被打开） | 快照时记下元素身份（AutomationId / Name / role），JS 随动作下发 `element_identity`；kernel 先按身份核对，不符则按身份重找并回报 `note`；身份也找不到就**明确失败**而不是点邻居 |
| P3b | `lib/uia.ps1` `Invoke-Action` | 激活窗口后才重建视图，但 UIA root 是激活**之前**取的（upstream 为绕 Chromium 激活期 HRESULT 抖动的取舍）。激活后整棵树作废：路径解到无名空节点、身份搜索也搜空树 | 激活成功后重新取一次 root，失败则保留旧 root |
| P4 | `lib/uia.ps1` click 返回 | 回执 `x/y` 打的是**屏幕坐标**，而工具面其它一切坐标（树 frame、marker、click 入参）都是**窗口相对**。1301×782 的窗口里回执 `(1259, 860)` 像是点到了窗口外；`InvokePattern` 路径更是根本没动光标 | `x/y` 统一改成窗口相对（与琥珀落点环一致），`InvokePattern` 的 note 明说「指针没有移动」 |
| P5 | `lib/uia.ps1` `Resolve-Window` | 进程名解析走 `Get-Process` + `MainWindowHandle` 取 `$procs[0]` —— **同名的任意一个进程**。两个 explorer 进程时 `app:"explorer"` 返回桌面壳（`Program Manager`，hwnd 65748）而不是任何文件夹窗口；刚启动、`MainWindowHandle` 还没填的 app 则表现为「窗口找不到」，可 `list_apps` 明明列着 | 改成与 `list_apps` 同一份可见窗口枚举：跳过桌面壳窗口 → 优先前台 → 否则取面积最大 → 再退标题匹配；`get_state` 回 `window.pick`（`by` / `candidates` / `ambiguous` / `foreground`），多候选时在树文本里显式告警 |

另外：`lib/uia.ps1` 存为 **UTF-8 with BOM**。PowerShell 5.1 对无 BOM 的脚本按系统 ANSI 代码页读，
本机 cp936 下任何非 ASCII 注释/字符串都会被读坏；加 BOM 后脚本按 UTF-8 解码。

## 验证

```powershell
# 稳定目标：小文件夹，避免 Explorer「正在处理…」的瞬态把用例抖成假阴性
$t = "$env:TEMP\cu-test"; mkdir $t -Force | Out-Null
1..3 | % { Set-Content "$t\item$_.txt" "probe $_" }
Start-Process explorer.exe $t
node scripts/local-verify.mjs --title "cu-test"
```

最近一次结果（2026-10-18，Win10 19045 / PowerShell 5.1 / DSH 0.2.1-rc.2）：

```
PASS  P5 app-name resolves to a real app window (not the desktop shell)  -- "C:\...\Temp\cu-test"  (pick: candidates=2 ambiguous=true)
PASS  P1 stdin UTF-8 round trip (CJK survives)                           -- "unicode 验收 42"
PASS  P3 identity wins over a drifted path                               -- note: identity-recovered-from-drift
PASS  P3 plain path route still works                                    -- SelectionItemPattern
PASS  P3 stale path fails loudly                                         -- element path '9.9.9.9' no longer resolves
PASS  P4 receipt x/y are window-relative (inside bounds)                  -- (1144, 19) vs 1301x782
SUMMARY: 6/6 passed
```

## 装配（本机 profile）

本 fork 在工作区里，profile 通过 **目录联接** 指向它，改完 JS 让插件重载即可生效；
`lib/uia.ps1` 的改动需要杀掉常驻 kernel 才重新加载（插件自己只在崩溃/超时/200 次请求后回收）。

```powershell
# 1) 杀掉常驻 UIA kernel
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  ? { $_.CommandLine -like '*uia.ps1*' } | % { Stop-Process -Id $_.ProcessId -Force }

# 2) profile 换成指向本 fork 的联接（旧的 npm 拷贝留作回滚）
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@milkuovo\dsh-computer-use"
if (Test-Path $p) { Rename-Item $p "dsh-computer-use.upstream-0.3.1" }
cmd /c mklink /J "$p" "D:\git-repository\github\dsh-computer-use"

# 3) 触发 profile patch 层重载（patchReload: live）
Add-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "`n# reloaded $(Get-Date -Format o)"
```

## 回滚

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@milkuovo\dsh-computer-use"
cmd /c rmdir "$p"                                   # 只删联接，不删工作区
Rename-Item "$p.upstream-0.3.1" "dsh-computer-use"
```

## 未做的事

- 没有提交（工作区 dirty，`LOCAL-PATCHES.diff` 是快照）。
- 没有改版本号：`package.json` 仍是 `0.3.1`，靠本文件区分上游与本地。
- 上游若发布修复，P1/P2/P5 大概会以不同写法落地，届时以 `LOCAL-PATCHES.diff` 逐条比对再决定丢弃哪几条。
