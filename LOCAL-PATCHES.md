# 本地补丁（独立维护线，基线 npm `@milkuovo/dsh-computer-use@0.3.1`）

这条独立维护线只做一件事：把本机实测到的缺陷修掉，不动上游的代码结构、工具面（10 个工具）、
配置项与 cordis 装配方式，所以它仍然是「一个 DSH 插件 + 一份 cordis patch」。

迭代分两批：**P1–P5**（`0.3.1-local.1`）修「点了会点错」；**P6–P13**（`0.3.2-local.1`）修
「根本点不到、且失败看不出来」及其后续回归；`0.3.2-local.2` 起的测试补强见文末「发布历史」。

- 基线：git `b85ecf2`（`release: 0.3.1`），npm 0.3.1
- 生成方式（**每次发版后重跑**，否则这份 diff 会落后于代码，照它回滚会丢掉新修复）：
  ```powershell
  git diff b85ecf2 HEAD -- lib/ mcp-server.mjs cordis.patch.yml README.md package.json > LOCAL-PATCHES.diff
  ```
  该文件与本说明都是**已提交**的发布物（不是未入库的本地草稿）。
- 验证脚本：`node scripts/local-verify.mjs --title <窗口标题片段>`（需要真实桌面会话）
- 复现脚本：`node scripts/local-repro.mjs --title <窗口标题片段>`（打印 list_apps / 名字解析 / 索引映射）
- 反向验证：`node scripts/reverse-check.mjs`（把每项修复在临时副本里回退，断言对应测试会变红）

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

---

# 0.3.2-local.2 ~ .7：修复、回归与测试补强

P6–P13 之后又走了六版，其中三版是**修自己引入的缺陷**。记在这里，是因为它们解释了代码里几处
看起来"绕"的写法，也标出了这条线踩过的坑。

| # | 提交 / 版本 | 问题 | 修法 |
|---|---|---|---|
| P14 | `a0ade00` / `0.3.2-local.3` | `element_index` 点击**完全不可用**：内核普通点击路径回 `note: null`，而 `click` 的 schema 把 `note` 声明为 string 且 `additionalProperties: false`，于是每次按索引点击都被宿主拒绝：`tool "click" returned invalid output: "value.note" must be a string`。marker 路径因为会用吸附判定覆盖 `note` 而侥幸正常 | 删掉合并结果里的 null 键（`lib/tools.js` 先精确删 `note`，再兜底删所有 null）；兜底跳过 `required` 的 `ok`，否则会把「校验失败」变成「缺必填字段」 |
| P15 | `5697ff0` / `0.3.2-local.4` | `local.2` 的坐标去重**实际无效**：条件要求 `coordinateSpace === captureSpace`，但前者恒为 `window`、后者在 `modelScale==1` 时为 `screenshot`，两者永不相等 | 只比较**坐标数值**：两点相等只说一次，仅在截图降采样、数值确实不同时才同时给出 |
| P16 | `45f18ad` / `0.3.2-local.5` | 琥珀落点环偏移一个窗口原点（P4 回归）：`withPointerMotion` 把内核回执的 `x/y` 直接当屏幕坐标传给 `recordAction`，而 P4 已把 click 的 `x/y` 改成窗口相对，`recordAction` 又减一次原点。实测窗口原点 `(120,120)`、点击 `(400,600)`，环画在 `(280,480)` | 先经快照 bounds 换算回屏幕坐标。**但这一版换算写在了对所有 action 生效的位置，引入了 P17** |
| P17 | `966b7be` / `0.3.2-local.6` | P16 的通用换算把 `scroll`/`drag` 反向带偏：它们的回执本就来自 `$toScreen`、是屏幕坐标（P4 只改了 click 的三个 return） | 收窄为 `kind === 'click'` 才换算；其余 action 原样记录。8 个 action 逐个实测，含 `.4`/`.5`/`.6` 三版对照 |
| P18 | `ba5161b` / `0.3.2-local.7` | P3 的 identity 恢复路径**一次都没被测过**：所有用例都用 `path=''` 且不带 identity；且 fixture 白名单停在 `Invoke-Action`，5 个用例自 P3 起一直红 | 白名单按性质分开——纯函数加载真实实现（`Find-ElementByIdentity`/`Convert-KeyChord`），会产生真实输入的（`Invoke-SecondaryAction`/`Invoke-Scroll`/`Invoke-Drag`）改为桩；新增「路径漂移按 identity 找回」与「identity 也找不到时必须失败且不点击」两条用例 |

## 测试基础设施

- `0.3.2-local.1` 起加 `test/output-schema.test.mjs`：用真实 PowerShell 边界 mock 驱动 `execute()`，
  调用宿主自己的 `validateJsonSchemaValue` 校验输出。**此前 `test/` 与 `scripts/` 从未校验过
  `output.schema`**，这正是 P14 能潜伏到线上的原因。
- `scripts/reverse-check.mjs`：把每项修复在临时副本里逐个回退，断言对应测试会变红。
  「测试通过」不能说明修复被锁住——这一步才能。
- `npm test` 现含 9 个测试文件，59 条断言全绿（`local.11`）。

## 已知缺陷（未修）

- `click.error` 是**死字段**：`.5` 为它加了 schema 声明，但全链路没有任何代码往 `merged.error` 写值，
  且 `lib/ps1.js` 在 `ok === false` 时直接 reject，render 的 `Click FAILED` 分支经 `execute()` 不可达。
  `perform_secondary_action` 的 `error` / `note` 同样拿不到。声明本身是为将来留位，
  但要知道它现在不会输出。
- `marker-raw` 回执最坏 598 字符（`element` 路径的 5.2 倍）。`nearby` 上限已在 `local.8` 收到 3 条、
  label 截到 40 字符；剩余长度来自最近控件列表本身，属预期。
- `get_app_state` 的 `treeText` 尾部现在混有五种风格的行（`Grid:` / `Amber ring:` 无前缀，
  `Note:` / `Truncated:` / `Warning:` / `Tree budget:` 带前缀）。语义自解释，但对模型不算干净。

### 测试夹具的隔离强度有上限（决定不再加固）

`test/fixtures/kernel-safety.ps1` 靠 PowerShell AST 从真实 `lib/uia.ps1` 按白名单抽取函数，
再配一套 C# mock 的 UIA 类型，从而在不碰真实桌面的前提下测内核决策逻辑。**这份夹具不进插件包**
（`package.json` 的 `files` 只含 `lib/`、`mcp-server.mjs`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`），
也不影响任何运行时行为。它的隔离来自"输入类型不存在"这一事实，现已加显式断言与逐用例检查。

但必须知道它**不是沙箱**。独立复核用全局键鼠钩子（含阳性对照）实测，以下四条都能让真实输入发生、
而测试仍然全绿：

| 绕过方式 | 实测后果 |
|---|---|
| 自建一个 P/Invoke 类型（如 `[Desk]`）带 `keybd_event` / `mouse_event` | 按键 2 次，守卫不报 |
| 用字符串拼接构造 COM ProgID（`'WScript'+'.Shell'`） | 按键 4 次，扫描器不匹配 |
| 把调用写进 `Assert-NoComInput` 剥离自身函数体时跳过的区间 | 单次运行 116 次按键 |
| 重定义同名函数覆盖真守卫（`IsolationGuard` 自增保留） | 按键 4 次，断言仍通过 |

根因是**所有检测都是黑名单**：查类型名、查方法名、扫文件字面量。黑名单总输给它没想到的名字。
真正可靠的做法是在抽取时改写源码、把输入调用换成桩（曾实现一半后放弃），但那属于测试基础设施工程，
收益仅限于"测试更可信"，与插件功能无关。

**判断：不再加固。** 触发前提是有人主动改这个测试文件并引入新输入通道；不改则永不触发。
代价与收益不成比例。若将来真要彻底解决，方向是 AST 改写而非继续加黑名单——
关键是别再用"检测"而要用"消除"。

> 复核同时确认：`test/*.mjs` 与 `scripts/*.mjs` 对 `scope` / `HasChildren` / `truncatedByDepth`
> 的断言一度为零，删掉相关逻辑测试不红。这些已补（`local.11`），`reverse-check` 覆盖 9 项。
> 但上表四条绕过至今无测试覆盖，也不打算补。

# 0.3.2-local.12：观察成本与动画时长（P19–P21）

前三批（P1–P18）都在修**正确性**：点了会点错、中文变乱码、失败不可见。这一批换方向，只做**延迟**，
触发点是本机实测发现单步约 5 秒，其中绝大部分不是模型在思考。

## 实测：成本根本不在树的大小

| 调用 | 耗时 | 说明 |
|---|---|---|
| `list_apps` | **75 ms** | 只有 IPC，不附着 UIA |
| `get_state` `maxDepth=0` | **72 ms** | 不展开子节点 |
| `get_state` `maxDepth=1` | **832 ms** | 展开第一层——断崖 |
| `get_state` 记事本（仅 3 元素） | **863 ms** | 元素少也一样贵 |
| `get_state` Electron 窗口（130 元素） | **714 ms** | 元素多反而略快 |
| 光标 spring `response=1.4` | **~1.4 s** | 每次指针动作前付一次 |
| 像素差分一帧（64×36 HSV） | **0.18–0.5 ms** | 比观察便宜 4 个数量级 |

**结论：820 ms 是 UIA 附着窗口 + 展开第一层子节点的固定成本，与 `maxNodes` / `maxDepth` 预算几乎无关。**
此前"降预算能省 10 倍"的判断是错的——那次测到的 345 ms 是 `truncated=true`，树在预算耗尽后
提前中断，等于没做完，省下来的是工作量而不是开销。所以**没有预算级优化空间**，只能减少观察次数。

## P19 — `scripts/local-verify.mjs` 的 P1 用例假失败

| 项 | 内容 |
|---|---|
| 症状 | `P1 stdin UTF-8 round trip` 恒红，读回的是文件夹路径 `C:\...\cu-test` 而不是探针字符串 |
| 根因 | 选择器硬编码 `e.name === '搜索框'`。Win10/11 的 Explorer 搜索框名字是**动态**的（`" 在 cu-test 中搜索"`，带前导空格），匹配不到就 `?? edits[0]` 回退——而 `edits[0]` 是**地址栏**。往地址栏写值等于导航，于是读回路径 |
| 修法 | 优先匹配 `/搜索|Search/i`；否则取第一个非地址栏的 Edit（地址栏判定为 `automationId === 'TextBox'` 且 `name` 含"地址栏/Address bar"）；都没有就**返回 null 并明确报错**，不再静默回退 |
| 验证 | 单独复测真搜索框：`set_value` → `read back "unicode 验收 42 中文"` → `MATCH: true` |

> 这条说明"用例红灯"未必是代码坏。判据是**看它操作了哪个元素**，不是看结果对不对。

## P20 — 光标动画响应时间可配（`fx.response`）

| 项 | 内容 |
|---|---|
| 症状 | `response=1.4` 是官方手感，但它在**每次指针动作前**都要付一次，五秒一步里占 1.4 秒 |
| 修法 | `overlay.ps1` 新增 `Set-SpringResponse($seconds)` 重算 `$STIFFNESS`/`$DRAG`，钳制 `[0.25, 3.0]`；首次 payload 与 `Start-SessionPlay` 两处解析 `params.response`；`tools.js` 经 `playOverlay` 透传；`index.js` 的 fx schema 新增 `response`（默认 1.4） |
| 为什么下限是 0.25 | 更短的 response 会让 spring 过冲，落点不再能读成"点在哪了"——落点自证是 P4 的核心价值 |
| 为什么不干脆关掉 | `fx.overlay: false` 能省更多，但会同时失去落点自证和蓝光高眼提示，等于放弃"动作是否生效"的唯一视觉反馈。**调短而不是关掉** |
| 实测 | `response=1.4` → 到达 3091 ms；`0.25` → 1655 ms（含 ~1.5 s 的 PowerShell 进程启动固定开销） |

> PowerShell 5.1 作用域已实测确认：`Set-SpringResponse` 内用 `$script:` 赋值，`Step-Spring` 内的裸读
> `$STIFFNESS` 能看到新值（100/10 → 999/99）。顶层脚本变量本就属 script 作用域，两种写法指向同一变量。

## P21 — `check_screen_change`：用像素差分决定值不值得观察

| 项 | 内容 |
|---|---|
| 新增内核 action | `pixel_probe`（`lib/uia.ps1` 的 `Invoke-PixelProbe`）：只 `CopyFromScreen` 一张 64×36 缩略图，转 RGB 字节 → base64。**不做 UIA 遍历、不建树、不借光标、不叠 fx** |
| 新增模块 | `lib/observe-gate.js`：RGB → 64×36 HSV 签名 → 加权距离（0–255，hue 环形）。签名采样步长取 `(cell)/4`，把 800×450 的成本从 ~1.7 ms 压到 ~0.5 ms |
| 新增工具 | `check_screen_change({app, threshold?})` → `{ok, changed, score, threshold, reason, elapsedMs, window}`。基线按 `app::pid::WxH` 存 `Map` |
| 阈值标定 | 沿用 see-now 的刻度：静止桌面 0.0、光标漂移 0.7、色调接近的照片切换 16–18、滚页/切窗 30–42。默认 12 落在"照片切换抓得住、光标抖动碰不到" |
| 实测 | `pixel_probe` 中位 **84–101 ms**，对比 `get_app_state` 820 ms，约 **8–10 倍**；连续两次探针 `score=0.00 / unchanged` |

### 这个工具**不能**做什么（写进工具描述，防止误用）

`check_screen_change` 只回答"画面像素变了没"。它：

- 不知道**哪个元素**变了（无 element_index、无坐标）
- 不能判断旧 `element_index` 是否仍然有效
- **不能用来验证动作是否生效**——动作验证仍然必须走 `get_app_state`

刻意的设计取舍：它**不调用** `requireFreshSnapshot`、也**不设** `observationRequired`。
如果让它参与闭环，模型就会用"屏幕没变"绕过"动作后必须重新观察"，那正好推翻 P3 修的
"路径漂移点到邻居还返回成功"。所以它的定位是**建议性门控**，不是观察替代品。

`probe` 失败时返回 `changed: true`（而非 false），确保失败被读成"需要观察"而不是"没变可以盲动"。

## 修正后的优化优先级

| 方向 | 收益 | 风险 | 状态 |
|---|---|---|---|
| 像素差分门控（P21） | 不变时 820 → ~100 ms | 低（建议性，不碰闭环） | 已做 |
| 动画调短（P20） | 每步省 1.0–1.2 s | 低（保留落点自证） | 已做 |
| 降 `maxNodes`/`maxDepth` 预算 | **接近零** | — | 已证伪，不做 |
| 局部重看替代全量重读 | 中 | 高（动闭环语义） | 不做 |
| UIA 事件订阅（`StructureChanged`） | 可到亚秒级 | 需重写 90KB PowerShell 内核 + COM 跨线程 + 事件风暴 | 不做 |

## 独立复核发现并已修复的缺陷（0.3.2-local.12 复审）

P19–P21 首次提交后经独立对抗性复核，发现**P21 当时 100% 不可用**。全部结论都在本机程序化复现，
以下每条都附了复现证据与修法。

### 致命（首次提交时）

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| F1 | **门控基线永远建不起来**：`shouldReobserve` 的 `no-baseline` 分支不返回 `signature`，而调用方只在 `if (verdict.signature)` 时 `set` | 连跑 3 轮全部 `reason=no-baseline, hasSig=false, mapSize=0` | 该分支补 `signature: next`，`shape-mismatch`/`bad-frame` 同样补 |
| F2 | **每次调用被宿主 schema 拒绝**：`score: undefined` 是自有可枚举属性，`snapshotJsonValue` 遇 undefined 让**整个 value** 变 `undefined`，随后抛 `ToolOutputError`；`window: null` 也违反 `type:'object'` | 用宿主真实 `validateJsonSchemaValue` 复刻：`snapshot=<undefined>`、`violations=["value" must be an object]` | `score` 恒为 number（无值时 `-1`）；`window` 用 `{}` |
| F3 | **`Invoke-PixelProbe` 不是缩略图，是左上角 1:1 裁剪**：`CopyFromScreen` 是位块传输，最后一个参数是"复制多少"，不是"缩放到多大"；`InterpolationMode` 对它是死代码 | 900×700 窗口把整窗刷蓝、**只保留左上 64×36 角落** → 距离 `0.00` → 判 unchanged。同一场景改抓全窗再 `DrawImage` → `82.87` | 先 `CopyFromScreen` 全尺寸位图，再 `DrawImage` 到目标尺寸 |

### 严重

| # | 缺陷 | 修法 |
|---|---|---|
| S1 | P19 只修了"写哪个元素"，**回查仍命中地址栏**：真 Explorer 里搜索框与地址栏 `automationId` 都是 `TextBox`，`elementsOf` 是 BFS 序，地址栏在前 | 回查改按 `path + name` 双条件 |
| S2 | HSV 的 hue 在近中性色上退化：`flat(240,240,240)` vs `flat(240,240,241)` = **43.26**，`flat(32,32,33)` vs `flat(32,32,32)` = **44.93** | hue 项按 `min(sa,sb)` **淡出**（不是硬阈值关掉） |
| S3 | 最小化窗口恒报 unchanged：rect 仍是旧值，`CopyFromScreen` 读到全黑，两次探针完全一致 | 补 `CuNative.IsIconic`，最小化直接 `Fail` |
| S4 | 探针会拍遮挡物：没有 `Activate-Window`，目标被覆盖时两次都在拍前景窗口 | 与 `Invoke-GetState` 对齐，探针前先激活（`params.activate` 可关） |
| S5 | "官方 1.4s 路径字节级一致"没实现：`fxResponse` 恒为 number，payload 永远多一个 `response:1.4` | 改 `...(fxResponse !== 1.4 ? {response: fxResponse} : {})` |

### 修复过程中自己引入并再次修掉的两处

**SR1 — 饱和度硬阈值把整个世界判成"没变"。**
先用 `s < 0.06` 时丢弃 hue 修 S2，结果两个**完全不同的窗口**（缩略图字节差异 84%）距离只有 **5.53**。
原因：现代 UI 全是灰白（v≈0.96、s≈0.004），颜色项无从发力。

**SR2 — 补结构信号后仍不过线。**
加"相邻格亮度梯度差"后升到 9.55，仍低于阈值 12。分量拆解显示 colour 5.53 / structure 8.12，
把结构权重从 0.5 提到 **1.2** 后 → **15.29**。同帧仍严格 0（结构项逐项相消），灰噪声 0.50。

> 这两条写在这里，是因为它们说明"按直觉调参"在这类算法上会连续错两次，
> 每次都必须用真实窗口对拍，不能靠单元测试的合成图。

### 复核明确验证无误的项（附验证方式）

- `Set-SpringResponse` 的 PowerShell 5.1 作用域：脚本级 `$X` 与 `$script:X` 是同一变量，函数内裸读会沿作用域链回退。实测 100/10 → 999/99，`Timer.Add_Tick` 的 scriptblock 也读到新值。
- `Resolve-Window` 返回 `[IntPtr]` 或 `$null`，`$null -eq $hwnd` 用法与 `Invoke-GetState` 一致。
- `GetPixel` 循环边界、`(y1-y0)/4` 除零、`distance` 的 `a.length/3` 循环、spring 数值稳定性（response=0.25 时 `dt·ω≈0.105`，半隐式欧拉稳定）。

### 新增测试

`test/output-schema.test.mjs` 增 3 条 `check_screen_change` 用例（首次调用必须过 schema、第二次同帧 unchanged、
变化帧 score 为正）。此前该工具**零覆盖**，F1/F2 才没有一条断言能发现它们。

`npm test` 现为 **63 条断言全绿**。

### 第二轮复核：M3 的第一次修复是错的

M3 要求把门控基线的 key 从 pid 改成窗口句柄。第一次修复写成：

```js
const identity = probe.window?.hwnd ?? probe.window?.pid ?? args.app;
```

但 `Invoke-PixelProbe` 的返回里，`hwnd` 在**顶层**，`window` 是 `Get-ProcessInfo` 的产物（只有 `pid` / `processName` / `path`）：

```
顶层键: hwnd, width, ok, rgb, window, height
r.hwnd: 50463612
r.window: {"path":"...","pid":37196,"processName":"DeepSeek Harness"}
r.window.hwnd: undefined
```

于是 `probe.window?.hwnd` 恒为 undefined，一路 fallback 到 pid——**M3 声称的修复实际从未生效，而且没有任何测试能发现它**（当时没有一条测试断言基线 key 的构成）。

改为 `probe.hwnd ?? probe.window?.pid ?? args.app`。

> 这条留在这里的原因是：它属于"改了、看起来对、测试也绿、但根本没走到"的一类缺陷。
> 与 P14（`note: null` 让整个 click 被拒）同源——**结构体字段的层级与宿主 schema 之间没有静态约束，
> 只能靠实际调用验证**。复核时"读到正确的变量名"不等于"读到正确的值"。

### 负向验证（证明测试真的锁得住）

回退单条修复，确认对应测试变红：

| 回退项 | 结果 |
|---|---|
| F1：去掉 `no-baseline` 分支的 `signature: next` | `output-schema.test.mjs` 变红：`expected a positive score, got -1` |
| F2：`result.score = -1` 改回 `undefined` | 变红：`actual: 'undefined', expected: 'number'` |

回退法才是"测试通过"与"缺陷被锁住"的分界线——这也是 `scripts/reverse-check.mjs` 存在的原因。

## 距离度量的第三次重写（最终形态）

P21 的门控判据改了三版，前两版都是错的，且**两次都错在相反方向**。记在这里，因为它是这段代码最难的部分。

### 第一版：HSV 加权和

`Δhue + Δsat + Δv` 加权。问题：近中性色上 hue 退化，1 LSB 噪声得 43–45 分（阈值 12），门控恒答"变了"。

### 第二版：hue 按饱和度淡出 + 亮度梯度

修好噪声后，**两个完全不同的窗口只有 5.53 分**，而**一行文字变两行只有 11.2 分**——同时低于阈值 12。即"屏幕换了"和"内容改了"都判不出来。

继续加"梯度差"信号后升到 9.55，把权重提到 1.2 到 15.29，但同一次调整让**一行→两行掉到 8.65**。加权重是拆东墙补西墙。

### 第三版（最终）：两个统计量 + 两条通道

根本错误在于**用单一均值承载两种不同的变化**。改成：

```
每格 d = max(|Δv|, chroma)           # 亮度差与色度差取大者，避免同亮度换色漏判
top5     = 变化最大的 5% 格子的均值    # 局部编辑在这里保持满强度
mean     = 全格均值                  # 只有整屏都动时才大
locality = top5 / mean               # 变化有多"集中"
```

判据：

| 条件 | 结论 | 语义 |
|---|---|---|
| `top5 >= 45 且 locality >= 3` | `detailed-change` | 局部内容/UI 状态变了 |
| `mean >= 60` | `wholesale-change` | 整屏重绘（切窗、滚页、换色） |
| 其余 | `unchanged` | 没实质变化 |

**为什么 locality 是关键**：全局变暗时每一格都在同等程度地变，`locality ≈ 1`；而文字编辑、按钮高亮只在少数格子剧烈变化，`locality` 12–20。这一条把"遮罩变暗"和"内容编辑"彻底分开——前者 `top5` 可以到 50 却仍然是 `unchanged`。

### 最终标定（全部实测）

| 场景 | top5 | mean | locality | 判定 |
|---|---|---|---|---|
| 同帧 | 0 | 0 | 0 | unchanged |
| 光标移 1px | 1.45 | 0.07 | 20.03 | unchanged |
| 文字抗锯齿 ±2 | 0.46 | 0.02 | 20.03 | unchanged |
| 悬停浅色调 | 25 | 2.78 | 9 | unchanged |
| 全局变暗 25（遮罩） | 25 | 25 | 1 | unchanged |
| 全局变暗 50（阴影） | 50 | 50 | 1 | unchanged |
| 对话框白底无边框 | 5 | 1.56 | 3.2 | unchanged |
| 一行→两行 | 178.55 | 8.91 | 20.03 | detailed |
| 文字换行 | 208.17 | 17.01 | 12.24 | detailed |
| 输入框焦点边（2px） | 70.96 | 3.54 | 20.03 | detailed |
| 选中行高亮 | 130 | 9.03 | 14.4 | detailed |
| 对话框带边框 | 54.67 | 4.04 | 13.53 | detailed |
| 按钮高亮 | 212.87 | 10.63 | 20.03 | detailed |
| 灰阶 20 vs 220 | 200 | 200 | 1 | wholesale |
| 红 vs 蓝 | 76.5 | 76.5 | 1 | wholesale |
| **真实窗口（DSH vs Explorer）** | 102.9 | 18.4 | 5.60 | detailed |

### 判据的语义边界

阈值 45 的依据不是"数值大小"，而是**语义分层**：悬停浅色调（25）是纯装饰，按钮高亮（213）是 UI 响应，两者必须分开。中间地带（阴影 50、对话框白底 5）落在 unchanged 是对的——它们确实没有改变窗口的可用内容。

`top5` 在 45–70 之间的场景（如输入框焦点边 70.96）判 `changed` 是**刻意选择**：焦点变化会改变后续键盘输入的落点，必须重新观察。

### 测试

`test/output-schema.test.mjs` 增 11 条判据用例，覆盖上述每一行标定。`npm test` 现为 **74 条断言全绿**。

### S3 的实际行为（与设计略有不同，但更安全）

设计上想在 `Invoke-PixelProbe` 开头用 `CuNative.IsIconic()` 拒绝最小化窗口。实测发现**走不到那一步**：

- 最小化后 `Resolve-Window` 按 app 名解析时，`MainWindowHandle` 归零、窗口枚举也不含它 → 直接 `Fail "target window not found"`
- 用 `hwnd:<n>` 直接指定也拿不到有效句柄（同样归零）

也就是说，最小化场景由 `Resolve-Window` 提前拦住，`IsIconic` 检查成了第二道防线（对"窗口可见但仍处于 iconic 状态"的少数情况有效）。两条路径都产生 fail-loud，**不会出现"全黑图重复 → 判 unchanged"** 这个危险结果。

保留 `IsIconic` 是因为它的代价为零，而"窗口可见但内容不可读"的边界情况确实存在（某些多显示器/虚拟桌面切换的中间态）。

### F3 验证证据（探针确实采样全窗）

对 `C:\Windows\System32` 文件夹窗口做探针，统计四个象限的唯一颜色数：

| 象限 | 唯一颜色数 |
|---|---|
| 左上 | 510 |
| 右上 | 196 |
| 左下 | 603 |
| 右下 | 228 |

四象限颜色分布互相独立，左上/右下平均亮度分别为 241.7 / 249.8。若仍是"左上角 1:1 裁剪"，右下象限会是左上的翻版、亮度完全一致。

### M3 验证证据（hwnd 在顶层）

```
r.hwnd         = 3672650        <- 代码读这个
r.window.hwnd  = undefined      <- 第一版错读的位置
r.window       = {path, pid, processName}
```

## 第四次（最终）度量重写：分布判据

第三次设计（`top5 / mean` 的 locality）被第三轮复核证明有**结构性缺陷**，不是调参能救的：

> 均匀幅度 V 覆盖面积占比 p 时，`mean = p·V`、`top5 = V`，故 **`locality ≡ 1/p`**，且硬上限 `cellCount/topN = 20.03`。
> 实测 n=1/5/20/60/116/200 格变化，locality 恒为 20.0348——它只是面积的倒数，**零集中度信息**。

由此产生死区：`p > 1/3 且 V < 60/p` 时两条通道都不触发。实测 **7/8 漏判**：

| 场景 | top5 | mean | locality | 旧判定 |
|---|---|---|---|---|
| 侧栏展开 40%, V=140 | 140 | 56.5 | 2.48 | ❌ unchanged |
| 底部抽屉 36%, V=150 | 150 | 55.3 | 2.71 | ❌ unchanged |
| 居中对话框 39%, V=45 | 45 | 17.6 | 2.56 | ❌ unchanged |
| 分栏 50%, V=100 | 100 | 50 | 2.00 | ❌ unchanged |

漏判方向正是「让调用方拿着陈旧 element_index 继续操作」——这个自检功能最不能犯的错。

### 最终设计：用分布，不用比值

```
dvP99  = 每格亮度变化的第 99 百分位   ← 局部编辑在这里保持满强度，不被面积稀释
dvMed  = 每格亮度变化的中位数          ← "屏幕有多大面积在动"
dcP99  = 每格色度变化的第 99 百分位   ← 同亮度换色（红→蓝）单独兜底
```

判据（顺序有意义）：

| 条件 | 结论 | reason |
|---|---|---|
| `dcP99 >= 40` | changed | `chroma-change` |
| `dvP99 < 40` | unchanged | `below-floor` |
| `dvMed >= 60` | changed | `global-large` |
| `dvMed >= 8` | unchanged | `global-dim` |
| 其余 | changed | `local-change` |

**为什么中位数是正确的那把尺**：全局变暗时每一格都在动，`dvMed` 等于峰值；局部变化时大多数格子没动，`dvMed` 接近 0。这一条把「遮罩变暗」和「内容编辑」彻底分开，而且不像 `mean` 那样被面积稀释，也不像 `locality` 那样退化成面积的函数。

### 最终标定（第四版，已被第五版取代——保留作为失败记录）

| 场景 | dvMed | dvP99 | dcP99 | 判定 |
|---|---|---|---|---|
| 同帧 | 0 | 0 | 0 | unchanged |
| 光标移 1px | 0 | 0 | 0 | unchanged |
| 文字抗锯齿 ±2 | 0 | 1 | 0 | unchanged |
| 悬停浅色调 | 0 | 5 | 25 | unchanged |
| 全局变暗 25 | 25 | 25 | 0 | unchanged |
| 全局变暗 50 | 50 | 50 | 0 | unchanged |
| **居中对话框 39%, V45** | 0 | 45 | 0 | **changed**（原死区） |
| **侧栏 40%, V100** | 0 | 100 | 0 | **changed**（原死区） |
| **抽屉 36%, V120** | 0 | 120 | 0 | **changed**（原死区） |
| 分栏 50%, V100 | 100 | 100 | 0 | changed |
| 一行→两行 | 0 | 220 | 0 | changed |
| 按钮高亮 | 0 | 35 | 255 | changed（色度通道） |
| 输入框焦点边 | 0 | 35 | 255 | changed（色度通道） |
| 红→蓝 | 0 | 0 | 76.5 | changed（色度通道） |
| 灰阶 20→220 | 200 | 200 | 0 | changed |
| 真实双窗口 | 4.2 | 61.2 | 34.6 | changed |

### S4 副作用的修正：探针不再抢占前台

第三轮复核发现，S4 加的 `Activate-Window` 让一个只读探针**抢走了用户的活动窗口**（实测前台从 hwnd 132386 变成 50463612）。这与 S4 想解决的「拍遮挡物」自相矛盾。

改为**默认不激活**：照当前屏幕抓，但在返回值里带 `foreground` 标志。JS 侧遇到 `foreground === false` 直接返回 `changed: true, reason: 'occluded'`——遮挡画面无法为目标窗口背书，两个遮挡帧还会互相比较得出"永远 unchanged"。`activate: true` 保留旧行为给愿意换窗口的调用方。

### 死代码清理（M1 的剩余部分）

- 删除 `export function distance()`：从未被调用，且语义已过时
- 删除 `HUE_MIN_SATURATION` / `LOCAL_MAGNITUDE_MIN` / `LOCALITY_MIN` / `WHOLESALE_MEAN_MIN`：全部失效
- 更新 `tools.js` 的工具描述与 `threshold` 说明（原写默认 12，实际 40）

### 测试

`test/output-schema.test.mjs` 的判据测试整块重写，覆盖新标定表每一行，含 4 个原死区场景。`npm test` 现为 **76 条断言全绿**。


## 第五版（当前）：离散度判据

第四版被复核证明仍有结构缺陷：`uniform 59 → unchanged` 但 `uniform 60 → changed`（一级断崖）、60% 覆盖的面板读"没变"、`floor(2304×0.99)=2280` 丢弃顶端 23 格。真实桌面 55 对窗口切换有 4 对误判为 unchanged。

### 前四版共同的错误：都在问错问题

它们都在问「画面变了多少」，而 `check_screen_change` 真正要回答的是**「调用方还能不能用手里那棵 UIA 树」**：

- **均匀变化**（遮罩变暗、夜间模式、亮度闪烁）：每个元素都还在原位 → **树仍然有效**
- **结构变化**（面板打开、文字增删、对话框弹出）：元素移动或出现 → **树已失效**

于是真正的判据不是幅度、不是面积、不是位置，而是**离散度**：

```
均匀变换 → 所有格子变化量相同 → sd ≈ 0
结构变化 → 部分格子变、部分不变 → sd 大
```

这条对覆盖率不敏感：90% 宽的侧栏 `sd≈14.5`，而整屏变暗 `sd` 严格为 0。

### 判据

| 条件 | 结论 | reason |
|---|---|---|
| `maxC >= 40` | changed | `chroma-change`（同亮度换色） |
| `maxV < 40` | unchanged | `below-floor`（没有值得看的东西） |
| `sd <= 6` | unchanged | `uniform-change`（树仍有效） |
| 其余 | changed | `structural-change` |

**用 `maxV` 而不是 percentile**：P99 会丢弃顶端格子，`max` 永远不会漏掉唯一变化的那些格子。

### 标定（全部实测）

| 场景 | meanV | sd | maxV | maxC | 判定 |
|---|---|---|---|---|---|
| 同帧 | 0.0 | 0.0 | 0 | 0 | unchanged |
| 光标 1px | 0.1 | 1.8 | 60 | 0 | unchanged |
| 文字抗锯齿 ±2 | 0.0 | 0.1 | 1 | 0 | unchanged |
| 悬停浅色 | 0.6 | 1.6 | 5 | 25 | unchanged |
| 均匀变暗 25/50/200 | 25/50/200 | **0.0** | 同 | 0 | unchanged |
| 灰阶 20→220 | 200.0 | **0.0** | 200 | 0 | unchanged |
| 侧栏 40%, V100 | 40.4 | 48.8 | 100 | 0 | changed |
| 抽屉 36%, V120 | 44.3 | 57.1 | 120 | 0 | changed |
| 对话框 39%, V45 | 17.6 | 21.9 | 45 | 0 | changed |
| 分栏 50%, V100 | 50.0 | 50.0 | 100 | 0 | changed |
| 覆盖 60%, V55 | 33.2 | 26.8 | 55 | 0 | changed |
| 覆盖 70%, V55 | 38.9 | 24.7 | 55 | 0 | changed |
| 覆盖 90%, V50 | 45.2 | 14.5 | 50 | 0 | changed |
| 一行→两行 | 8.9 | 40.2 | 220 | 0 | changed |
| 文字换行 | 17.0 | 53.0 | 210 | 0 | changed |
| 按钮高亮 | 1.5 | 7.0 | 35 | 255 | changed（色度） |
| 输入框焦点边 | 0.5 | 4.1 | 35 | 255 | changed（色度） |
| 红→蓝 | 0.0 | 0.0 | 0 | 76 | changed（色度） |
| 0.5%/1%/2% 满对比方块 | 1.7/3.4/6.7 | 18.9/26.2/36.6 | 250 | 0 | changed |
| **真实窗口 45 对（10 窗口）** | — | — | — | — | **45/45 changed** |

最后一行是安全指标：第四版在 55 对里误判 4 对，第五版 45 对全对。

### `sd <= 6` 这个阈值不是调出来的

均匀变换实测 `sd` 严格为 0；标定集里最小的结构性变化是「36% 抽屉」`sd=57`、最紧的是「90% 覆盖」`sd=14.5`。光标漂移 1.8、文字抗锯齿 0.1 都在 `maxV < 40` 那关就被挡住。6 落在"均匀(0)"与"最小真实结构(14.5)"之间的空带里。

### 工具层参数约束的限制

DSH 的参数 schema DSL **不支持** `minimum`/`maximum`（实测报 `not supported by the value schema DSL`），所以工具层无法声明 threshold 范围；范围校验只在配置 schema（`z.number().min(1).max(255)`）里。

## 第六版（当前）：带符号残差 + 计数

v6 的 `devCount` 被复核证明仍有结构缺陷，两条：

1. **依赖网格相位**：同一侧栏，边界落在格边界上 `devCount=0`，落在格内部 `devCount=36`。判据成败取决于一个与被测语义无关的像素相位量。
2. **多区域抵消**：分栏 240/40 内容互换被判 `unchanged`。

### 根因

v6 用 `|Δv|` 数偏离。内容互换是 **+200 / −200**，取绝对值后两边都读 200，变化量场变得平坦，中位数也就是 200，残差全为 0。

### v8 的两处改动

1. **带符号增量** `Δv = b − a`。互换的 +200/−200 中位数是其中之一，另一半残差 400——全格偏离。
2. **残差阈值 25 → 18**。降下来后，「左半 −100 / 右半 −80」这类相邻但不相同的大区域也能分开（原来差 20 落在同一带内互相抵消）。

判据（`RESIDUAL_MIN=18`, `RESIDUAL_CELLS=8`）：

| 条件 | 结论 | reason |
|---|---|---|
| `maxC >= 40` | changed | `chroma-change` |
| `maxAbs < 39` | unchanged | `below-floor` |
| `devCount >= 8` | changed | `structural-change` |
| 其余 | unchanged | `uniform-change` |

### 标定（全部实测）

| 场景 | median | devCount | maxAbs | maxC | 判定 |
|---|---|---|---|---|---|
| 同帧 | 0 | 0 | 0 | 0 | unchanged |
| 光标 1 格 | 0 | 4 | 165 | 0 | unchanged |
| 悬停浅色 | 0 | 0 | 5 | 25 | unchanged |
| 均匀暗 25 / 45 / 50 | -25/-45/-50 | 0 | 同 | 0 | unchanged |
| 均匀重绘 +200 | 200 | 0 | 200 | 0 | unchanged |
| 遮罩+框 200×120 (1.1%) | -45 | **27** | 45 | 0 | changed |
| 遮罩+框 396×225 (4.3%) | -45 | **97** | 45 | 0 | changed |
| 遮罩+框 1200×700 (41%) | -45 | **924** | 45 | 0 | changed |
| 遮罩+深框 200×120 | -45 | **32** | 130 | 0 | changed |
| **侧栏 x=40（对齐）** | -100 | **864** | 100 | 0 | changed |
| **侧栏 x=41（不对齐）** | -100 | **828** | 100 | 0 | changed |
| **侧栏 x=50** | -100 | **504** | 100 | 0 | changed |
| 左100/右80 | -81 | 0 | 100 | 0 | unchanged（同带） |
| 左100/右70 | -71 | **1152** | 100 | 0 | changed |
| **分栏互换 +200/-200** | 200 | **1152** | 200 | 0 | changed |
| **双色调主题切换** | 176 | **1152** | 190 | 0 | changed |
| 一行→两行 | 0 | **114** | 112 | 0 | changed |
| 按钮高亮 | 0 | 0 | 35 | 255 | changed（色度） |
| 红→蓝 | 0 | 0 | 0 | 76 | changed（色度） |
| **真实窗口 28 对** | — | 最小 **346** | — | — | **28/28 changed** |

最后一行余量极大：真实窗口之间 `devCount` 最小 346，阈值是 8。

### 已知边界（不是缺陷）

覆盖约 **99.7% 以上** 的变化与均匀变换**在构造上不可区分**——主导变换本身就是那个变化，残差趋近 0。这与整屏重绘的行为一致：两者都没有以 `devCount` 能看见的方式移动布局。

「左半 −100 / 右半 −80」判 unchanged 同理：两区差 20 落在同一带内，且各自完全均匀，元素位置未变。

### 测试

`test/output-schema.test.mjs` 判据测试整块重写，覆盖上表每一行，含：
- 侧栏相位无关性（x=40/41/43/45/50 全部检出）
- 分栏内容互换、双色调主题切换
- `PEAK_FLOOR` 默认值的独立覆盖（不传 opts）

`npm test` 现为 **83 条断言全绿**。

## 第七版（当前）：连通性判据

采纳复核意见删掉 `PEAK_FLOOR` 后，暴露了一个新问题：**独立噪声的 devCount 也是大的**。

实测（160×90 探针）：两帧独立随机噪声 `devCount=670`（矩阵共 2304 格），因为每一格都与中位数不同——噪声天然满足"偏离主导变换"。

`PEAK_FLOOR` 原本挡的是这个，但它同时挡掉了低对比度的真实结构变化（深色主题 40% 面板 V=25~38 全部漏判）。所以不能简单地恢复 floor。

### 关键区分：噪声是散点，结构是成片

```
conn = 邻接的偏离格对数 / 偏离格数
```

实测：

| 场景 | devCount | conn |
|---|---|---|
| 独立随机噪声 ×3 | 627–684 | **0.55–0.58** |
| 遮罩+对话框 | 192 | 1.85 |
| 侧栏 | 936 | 1.93 |
| 深色面板 V25 | 900 | 1.93 |
| 一行→两行 | 64 | **0.98**（最小真实结构） |
| 分栏互换 | 1152 | 1.94 |
| 双色调切换 | 1152 | 0.97 |
| 光标 2px | 6 | 1.17（被 devCount 挡掉） |

阈值 **0.85**：噪声侧余量 0.27，最小真实结构（文字行 0.98）侧余量 0.12。

### 最终判据

| 条件 | 结论 | reason |
|---|---|---|
| `maxC >= 40` | changed | `chroma-change` |
| `devCount < 8` | unchanged | `uniform-change` |
| `conn < 0.85` | unchanged | `scattered-change` |
| 其余 | changed | `structural-change` |

**没有幅度地板**：低对比度的结构变化（深色主题 V=25）能正确检出，而噪声由连通性挡住。

### 验证

- `npm test`：**85/85 全绿**
- 合成 21 例，除下面那条已知边界外全过
- **真实窗口 28 对，0 漏判，conn 0.97~1.55**
- **空转 5 个窗口，0 误报**（devCount 全为 0）

### 已知边界

**±100 幅度的逐像素随机噪声**（conn=1.11）与结构变化不可区分——极端幅度下噪声经 64×36 缩略后形成连通块。

这个场景不真实：屏幕捕获是**无损**的（`CopyFromScreen` 没有传感器噪声），实测真实空转 `maxAbs ≤ 1.2`、`devCount = 0`。合成的高幅度随机噪声不代表任何真实工况。

### 另外两条已知边界（沿用第六版结论）

- 覆盖约 99.7% 以上的变化与均匀变换在构造上不可区分
- 两个区域各自均匀、变化量差 < 36 时 `devCount` 归零（元素位置未变，树仍有效）
