# 本地补丁（独立维护线，基线 npm `@milkuovo/dsh-computer-use@0.3.1`）

这条独立维护线只做一件事：把本机实测到的 5 个缺陷修掉。上游代码结构、工具面（10 个工具）、
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

本仓库在工作区里，profile 通过 **目录联接** 指向它，改完 JS 让插件重载即可生效；
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

- 上游若发布修复，P1/P2/P5 大概会以不同写法落地，届时以 `LOCAL-PATCHES.diff` 逐条比对再决定丢弃哪几条。

---

# 0.3.2-local.1 追加：工具栏点不中这条链路

上一版（`0.3.1-local.1`）修的是「点了会点错」；这一版修的是「根本点不到、且失败看不出来」。
根因是三层叠加，不是单点缺陷：

```
maxDepth: 8 剪掉 depth 11-12 的工具栏
   └→ 工具栏不进 treeText → 模型既没有 element_index，也没有覆盖它的 marker → 只能猜像素
冷启动首次 UIA 查询只返回原生外壳（14 元素）
   └→ 那次快照看起来完全合法（不截断、不报错）→ 被当成「这个应用就这么多控件」
click({marker}) 吸附候选池为空
   └→ 退化为裸像素点击，回显只有 "Clicked (coordinate) at (x, y)"，看不出是猜的
```

| # | 位置 | 症状（本机实测） | 修法 |
|---|---|---|---|
| P6 | `lib/index.js`、`lib/tools.js`、`lib/uia.ps1`、`cordis.patch.yml`、`mcp-server.mjs` | `maxDepth: 8` 下同一窗口只有 3 个 Button（全是标题栏 caption），工具栏 20 个按钮一个不进树 | 六处默认值统一为 `maxDepth: 15` / `maxNodes: 1600`；`maxNodes` 必须同步放大，否则会和深度同时截断、让 `maxDepth` 形同无效 |
| P7 | `lib/uia.ps1` `Invoke-GetState` | Chrome/Electron 冷启动后首次查询只拿到 14 个元素的原生外壳，web 子树尚未建好；该结果不截断不报错，被当成完整快照 | 按**可测规模**判定（未截断 + 窗口 ≥400000 px² + 元素数 <40），最多重试 3 次；每轮与当前最优比较并保留最多元素那份，绝不返回更差结果。**不用**「有没有 Document」作判据 —— 资源管理器 155 元素、完整可用却无 Document，那条会每轮误重试 |
| P8 | `lib/tools.js` `get_app_state` | 参数表只有 `app`，模型没有提深手段；内核算好的 `truncatedByDepth`/`nodeCount` 被工具层丢弃，模型看不到自己被截断 | 新增单次 `maxDepth`/`maxNodes` 覆盖参数（clamp 与内核同源）；回传诊断字段；`treeText` 追加 `Warning:` / `Note:` / `Tree budget:` 可见行 |
| P9 | `lib/uia.ps1` 深度判定 | depth 边界上的**叶子节点**也被判为截断，导致每个窗口都报 `truncatedByDepth=true`，警告全是噪声 | 先 `FindFirst(Children)` 确认真有子元素才标记截断 |
| P10 | `lib/tools.js` `snapMarkerPoint` + `click` render | 吸附失败静默退化为裸像素；`via` 恒为 `coordinate`，吸附成功与失败不可区分；`note` 只进 `value`，不进模型可见的 `render` | 返回判定而非裸点；`via` 四态（`marker-snapped`/`marker-raw`/`coordinate`/`element`）；render 四态输出，同时给 window 与 screenshot 两个坐标系、命中元素名、未吸附时的最近控件偏移与距离 |
| P11 | `lib/tools.js` `snapMarkerPoint` 上限 | `cap = 0.18×min(w,h)≈297px` 允许 163px 高的整条工具栏容器当宿主：131 个 marker 里 28 个位移 >60px、18 个 >150px、最大 **225px**，却报「吸附成功」——比裸点更危险，因为它伪装成成功 | `hostCap = 0.08×min(w,h)≈132px` + `moveCap = 0.25×hostCap≈48px`；超限回落裸像素并说明原因。复测 >60px 归零、最大 43px |
| P12 | `lib/uia.ps1` `Get-GridMarkers` | 补点前缀 `E` 与网格列标签冲突（11 列是 A..K，格点已占 E1–E7，补点从 E8 起被读成「第 5 列第 8 行」）；补点无数量上限（注释称 ≤100，实际 `while` 只管格点） | 前缀改 `N`，并加 40 个上限 |
| P13 | `lib/uia.ps1` pattern 探测 | `GetSupportedPatterns()` 是跨进程全量查询：563 个元素实测 1681ms，占整次遍历 73% | 改为按插件实际消费的 8 个 pattern 逐个 `TryGetCurrentPattern`：441ms（3.8×）；整次 `get_app_state` 2292ms → 1535ms。逐元素双探针核对 637 个元素，pattern 集合完全等价 |

## 0.3.2-local.1 验证

```powershell
# P1–P5 回归（需真实桌面会话）
node scripts/local-verify.mjs --title "cu-test"
```

实测结果（2026-11-02，Win10 / PowerShell 5.1 / 资源管理器目标窗口）：

```
PASS  P5 app-name resolves to a real app window (not the desktop shell)  -- pick: candidates=2 ambiguous=true
PASS  P3 identity wins over a drifted path                               -- identity-recovered-from-drift
PASS  P3 plain path route still works                                    -- SelectionItemPattern
PASS  P3 stale path fails loudly                                         -- element path '9.9.9.9' no longer resolves
PASS  P4 receipt x/y are window-relative (inside bounds)                 -- (555, 50) vs 2278x1271
PASS  P1 stdin UTF-8 round trip (CJK survives)                           -- "unicode 验收 42"（见下方注）
SUMMARY: 6/6 passed
```

> **注**：`local-verify.mjs` 的 P1 用例取 `edits[0]`，在资源管理器里那是**搜索框**——它的
> `SetValue` 会被搜索建议覆盖，属系统行为（原值是空，地址栏才是原值「主文件夹」）。
> 改用地址栏做同一往返即原样读回 `unicode 验收 42`。这是**测试选错了控件**，不是编码缺陷。

新增项验证：

| 项 | 结果 |
|---|---|
| 惰性树热窗口不误触发 | `retries=0 gained=0`（资源管理器 163/155 元素、无 Document，均不重试） |
| 浅预算仍报真实截断 | `maxDepth:3` → `truncatedByDepth=true, retries=0`，未被重试掩盖 |
| 冷树模拟（首遍压到 5 元素） | `retries=1, gained=131`，返回 145 元素（真实冷启动实测：首次 `get_app_state` 输出 `Note: the first pass saw only 14 element(s) … gained 131`） |
| 恒空树模拟（每轮都 5 元素） | `retries=3, gained=0, unresolved=true`，返回首遍而非更差结果 |
| `N` 前缀锚点 | 131 个 marker 中 `N` 锚点 40 个（上限生效） |
| 吸附位移 | 旧规则 28 个 >60px / 最大 225px；新规则 **0 个** / 最大 43px |

## 装配（本机 profile）

工作区在 `D:\dsh-plugins\dsh-computer-use`（本仓库），profile 通过**目录联接**指向它，
改完 JS 让插件重载即可生效；`lib/uia.ps1` 的改动需要杀掉常驻 kernel 才会重新加载
（插件自己只在崩溃/超时/200 次请求后回收）。

```powershell
# 1) 杀掉常驻 UIA kernel
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  ? { $_.CommandLine -like '*uia.ps1*' } | % { Stop-Process -Id $_.ProcessId -Force }

# 2) profile 换成指向本仓库的联接（旧的 npm 拷贝留作回滚）
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@milkuovo\dsh-computer-use"
if (Test-Path $p) { Rename-Item $p "dsh-computer-use.upstream-0.3.1" }
cmd /c mklink /J "$p" "D:\dsh-plugins\dsh-computer-use"

# 3) 触发 profile patch 层重载（patchReload: live）
Add-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "`n# reloaded $(Get-Date -Format o)"
```

## 回滚

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@milkuovo\dsh-computer-use"
cmd /c rmdir "$p"                                   # 只删联接，不删工作区
Rename-Item "$p.upstream-0.3.1" "dsh-computer-use"
```

## 已知限制

- 惰性树重试只在「元素数 <40 且窗口 ≥400000 px²」时触发。更小的 Electron 对话框冷启动时仍可能
  拿到空树且无信号——阈值以下不做重试是有意为之（小窗口重试纯浪费），但这个小窗户是真的。
- 重试体与主遍历是两段近乎重复的代码（约 90 行）。逐条比对过 pattern 列表、offscreen 过滤、
  深度与节点截断判定，行为差异为 0；但这段重复本身是维护负担，后续改遍历逻辑应提取成共享函数。
- **真实的冷启动形态未能稳定复现**：多数情况下窗口首查已是完整树，惰性重试处于待命状态。
  它生效时的可见证据是 `Note: the first pass saw only N element(s) … gained M`。
