# 更新记录

## 0.3.2-local.10 — 2026-11-02

复核指出夹具提供的保证比看上去弱，两处均已加固：

- **隔离原本是「碰巧」，现在是显式断言**。夹具只用 AST 抽取**函数体**，`uia.ps1` 顶层的
  `Add-Type` / `Add-Type -AssemblyName` 从不执行，所以 `[CuInput]`、`[System.Windows.Forms.SendKeys]`、
  `[System.Drawing]` 天然不存在——把它们挡在门外的是这个巧合，不是设计。
  只要有人为测 `set_value` 在这里加一行 `Add-Type -AssemblyName System.Windows.Forms`，
  被真实加载的 `Invoke-Action` 就会开始向真实窗口发键盘，而测试仍然全绿。
  现在在任何用例执行前断言这三类不可用，并检查 mock `CuNative` 不含输入方法
  （它是只读 mock，名字本身不能证明什么）。两个方向都实测：正常跑通过；
  人为加载程序集会被明确报错拦下。
- **`FindAll`/`FindFirst` 不再忽略 scope 与叶子状态**：内核除 `uia.ps1:1738` 一处 `Descendants` 外
  都用 `Children`，而 scope 盲的 mock 无法发现用错 scope；`HasChildren` 开关默认 true，
  使叶子节点可以真正报告「没有子元素」——此前对任何节点都回答「有子元素」，
  会让内核的「深度边界上的叶子不算截断」判定恒真，而那正是惰性树重试所依赖的信号。

全套测试 57/57；反向检查守卫仍判定干净副本为干净。

## 0.3.2-local.9 — 2026-11-02

独立复核（夹具与用例）推翻了两处此前的结论，均已修复：

- **`scripts/reverse-check.mjs` 会对任何回退——包括没有回退——打印 PASS**。三个缺陷叠加：
  副本排除了 `node_modules`（测试连 `@deepseek-ai/dsh-tools` 都 import 不了，必然"失败"）；
  失败正则把**文件级**行 `✖ test\output-schema.test.mjs` 当成用例名收下（import 崩溃看起来像用例失败）；
  `join("")` 得到 `.` 使排除串变成 `..git`（`.git` 反被复制）。
  实测：未做任何修改的干净副本也返回非空失败列表。**因此上一版"七项修复全部有保护力"的结论是假的。**
  现在会挂载依赖、只认用例级失败、把跑不起来的副本判为失败而非通过；
  新增 `scripts/check-reverse-check.mjs` 专门守这一点，并纳入 `npm test`。修好后七项全部真实反向验证通过。
- **P3 用例没测到 drift 分支**。此前用 `path=′9.9.9.9′`（不可解析），走的是 `uia.ps1:1624` 的
  「路径解析不到」，报告 `identity-recovered`。而 P3 真正要防的是 `uia.ps1:1628` 的
  「路径仍能解析、但解析到了别的元素」——该分支**零覆盖**：把它整个禁用后测试仍全绿（已实测）。
  fixture 现在能造出这种树形状（序号 0 是诱饵、真实元素在旁边），新增两条用例覆盖
  `identity-recovered-from-drift` 与不可恢复时的失败（报出实际找到的元素、且不点击任何东西）。
- `Reset-Fixture` 现在清理 mock 开关（`IdentityChildName` / `DriftDecoyName`）：
  此前残留会让用例顺序决定结果。`TreeScope` 改用真实 UIA 的枚举值与 `[Flags]`。

全套测试 57/57；`reverse-check` 7/7，每条 PASS 都附具体失败用例名。

## 0.3.2-local.8 — 2026-11-02

独立复核（发布物与端到端）发现三处发布物问题，其中一处是真实回滚陷阱：

- **`LOCAL-PATCHES.diff` 落后 7 个版本**：它停在 `0.3.2-local.1`（1089 行，实际 `b85ecf2..HEAD` 为 1462 行），
  而 `LOCAL-PATCHES.md` 把它写成回滚比对基线——照它回滚会**悄悄丢掉 `.2`~`.7` 全部六项修复**。
  已重新生成，并把生成命令（含必须带上的 pathspec）写进文档，每次发版都要重跑。
- **`LOCAL-PATCHES.md` 自述与事实相反**：原文写它和 diff「留在工作区，未提交」，实际两者自 `e6cc5a7` 起
  就已被 git 跟踪。已更正；同时补上 P14–P18 与「已知缺陷」清单——它此前停在 P13，落后 CHANGELOG 六个版本。
- `nearby` 收到 3 条、label 截到 40 字符：`marker-raw` 回执最坏曾达 598 字符（`element` 路径的 5.2 倍），
  且 56 字符的容器名会把真正有用的控件挤到末尾。
- `scripts/reverse-check.mjs` 纳入 P3：在自己的副本里改写 fixture 白名单，断言两条 identity 用例变红。
  至此七项修复全部经反向验证。

## 0.3.2-local.7 — 2026-11-02

- **补完 fixture 白名单，让 P3 的 identity 恢复路径真正可测**：此前白名单停在 `Invoke-Action`，
  5 个用例自 P3 起一直红；且所有用例都用 `path='` 且不带 identity，恢复路径**一次都没被跑到**。
- 白名单按性质分开：纯函数加载真实实现（`Find-ElementByIdentity` 只遍历树、`Convert-KeyChord` 只解析按键）；
  会产生真实输入的（`Invoke-SecondaryAction` / `Invoke-Scroll` / `Invoke-Drag`）改为桩，
  与既有的 `Invoke-ClickAt` 一致，各自记录被请求的动作。加载真实动作函数会让测试真的移动鼠标。
- 新增两条用例：路径漂移时按 identity 重新找到元素并在回执标注 `identity-recovered`；
  identity 也找不到时**明确失败且不点击任何东西**——后者正是 P3 存在的理由。
- mock 仅补到能表达上述场景（`FindAll`/`FindFirst` 子元素 + 可配置子元素名），仍不发送任何输入。
  全套测试 55/55。

## 0.3.2-local.6 — 2026-11-02

- **修正 local.5 引入的新回归**：那次把内核回执转成屏幕坐标的换算写在了 `withPointerMotion`，对**所有** action
  生效，但 P4 只改了 click 的三个 return。`scroll`/`drag` 的回执本来就是屏幕坐标（`$pt`/`$pt2`），
  被多加了窗口原点。现在只对 click 换算。
- 补 `scroll`/`drag` 两条用例：这两个 action 此前**完全没有覆盖**，所以上面的回归才漏过去。
- **新增 `scripts/reverse-check.mjs`**：把每项修复在临时副本里逐个回退，断言测试会变红。
  六项修复全部验证为「有保护力」——没有这一步，「测试通过」并不能说明修复真的被锁住。
- 把 `test/output-schema.test.mjs` 加入 `npm test`：此前它没被任何脚本引用，`npm test` 只跑到 43 条，
  新用例默认不执行。
- `@deepseek-ai/dsh-tools` 声明进 `devDependencies`：新用例从它导入 `validateJsonSchemaValue`，
  干净 clone 下此前无解析路径。全套测试现为 53/53。
- 说明：`Click FAILED` 分支经 `execute()` 不可达（`ps1.js` 在 `ok:false` 时先 reject），
  用例改为直接校验 render 契约，不再假装测试该路径。

## 0.3.2-local.5 — 2026-11-02

- **修复琥珀落点环偏移一个窗口原点**（P4 回归，高危）：`withPointerMotion` 把内核回执的 `x/y` 直接当屏幕坐标
  传给 `session.recordAction`，而 P4 已把内核 `x/y` 改为窗口相对，`recordAction` 又减一次原点。
  实测：窗口原点 `(120,120)`、点击 `(400,600)`，环画在 `(280,480)`，偏差正好是原点。
  现在先经快照 bounds 换算回屏幕坐标。
- `click` 的 output schema 补 `error` 字段；`ok:false` 时回执改为 `Click FAILED (<via>) — <error>`，
  不再以 `Clicked (...)` 开头，避免「被拒绝的动作」读起来像成功。
- 兜底删 null 时跳过 `required` 字段：删掉 `ok` 会把「校验失败」变成「缺必填字段」，更难诊断。
- **新增 `test/output-schema.test.mjs`（7 个用例）**：此前 `test/` 与 `scripts/` 从未用 `output.schema`
  校验过任何工具输出，所以 `note: null` 才能潜伏到线上。用真实 PowerShell 边界 mock 驱动 `execute()`，
  并调用宿主自己的 `validateJsonSchemaValue`：覆盖 null note、坐标去重两种形态、未吸附 marker、
  琥珀落点、被拒绝的点击、required 字段保护。
- 修 `test/fixtures/kernel-safety.ps1` 的函数白名单：它停留在 P3 之前，缺 `Test-ElementIdentity` /
  `Get-ElementIdentity`，导致 5 个用例自 P3 落地起一直红（在 `60d132e`、`e6cc5a7`、`04d00c9` 上均复现）。
  全套测试现为 50/50。


## 0.3.2-local.4 — 2026-11-02

- **修正 0.3.2-local.2 的无效修复**：去重条件要求 coordinateSpace === captureSpace，但
  coordinateSpace 恒为 'window'，而 modelScale == 1 时 captureSpace 为 'screenshot'，
  两者永不相等，回执实际仍在重复（at window (87, 103) = screenshot (87, 103)）。
  改为只比较**坐标数值**：两点相等时只说一次，仅在截图被降采样、数值确实不同时才同时给出。

## 0.3.2-local.3 — 2026-11-02

> **更正（0.3.2-local.4）**：本条的坐标去重实际未生效——条件要求 `coordinateSpace === captureSpace`，但前者恒为 `window`、后者在 `modelScale==1` 时为 `screenshot`，两者永不相等，回执仍在重复。已在 `0.3.2-local.4` 改为只比较坐标数值。本条描述保留原样，仅作历史记录。

- **修复 `element_index` 点击完全不可用**：内核在普通点击路径返回 `note: null`（`uia.ps1` 在漂移检查前
  把 `$note` 置为 `$null`），而 `click` 的 output schema 把 `note` 声明为 string 且
  `additionalProperties: false`，于是每次按索引点击都失败：
  `tool "click" returned invalid output: "value.note" must be a string`。
  marker 路径因为会用吸附判定覆盖 `note` 而侥幸正常。现从合并结果中删除 null 键，
  避免将来任何可空的内核字段再次拖垮整次调用。

## 0.3.2-local.2 — 2026-11-02

> **更正（0.3.2-local.4）**：本条的坐标去重实际未生效——条件要求 `coordinateSpace === captureSpace`，但前者恒为 `window`、后者在 `modelScale==1` 时为 `screenshot`，两者永不相等，回执仍在重复。已在 `0.3.2-local.4` 改为只比较坐标数值。本条描述保留原样，仅作历史记录。

- click 回执不再重复同一个坐标：modelScale 为 1（常态）时 x/y 与 captureX/Y 是同一个窗口相对点，
  之前输出 t window (87, 103) = window (87, 103)。现在两点一致时只说一次，仅在截图被降采样、
  两个空间确实不同时才同时给出。

## 0.3.2-local.1 — 2026-11-02

在 `0.3.1-local.1`（P1–P5 基线）之上，修掉「工具栏点不中」这条链路上的三层缺陷。P1–P5 全部保留，逐项回归通过。

**根因链**：`maxDepth: 8` 剪掉 depth 11–12 的工具栏 → 冷启动首次 UIA 查询只拿到原生外壳（14 元素）→
`click({marker})` 的吸附候选池为空 → 退化为裸像素点击且回显看不出 → 用户只能靠猜像素。

- **遍历预算** `maxDepth` 8→15、`maxNodes` 400→1600，六处默认值同源（`lib/index.js` schema、`lib/tools.js`、
  `lib/uia.ps1` 内核兜底、包内 `cordis.patch.yml`、profile patch、`mcp-server.mjs`）。
  实测同一窗口 d8 只有 3 个 Button（全是标题栏），d15 有 50–87 个、工具栏 20 个全在。
  `maxNodes` 必须同步放大：400 会和深度同时截断，让 `maxDepth` 形同无效（15 深的 Electron 窗口约访问 500 次）。
- **惰性无障碍树重试**（`lib/uia.ps1`）：Chrome/Electron 冷启动后首次查询只返回 14 个元素的原生外壳，
  隔一会再查才是完整树。判定**只看可测规模**（未截断 + 窗口 ≥400000 px² + 元素数 <40），最多重试 3 次；
  每轮与当前最优比较并保留元素最多的那份，绝不返回更差结果；`lazyTreeGained` 记录净增，`gained=0` 时不谎报重建。
  不采用「有没有 Document 节点」作判据 —— 资源管理器有 155 元素、完整可用却无 Document，那条判据会每轮误重试。
- **`get_app_state` 单次预算覆盖**：新增 `maxDepth` / `maxNodes` 参数（clamp 与内核同源），
  此前参数表只有 `app`，模型没有提深手段。
- **截断信号回传给模型**：回传 `nodeCount` / `interactiveCount` / `maxSeenDepth` / `maxDepthUsed` /
  `maxNodesUsed` / `truncatedByDepth` / `truncatedByNodes` / `lazyTree*`，并在 `treeText` 追加
  `Warning:` / `Note:` / `Tree budget:` 三类可见行。此前内核算好了这些但工具层全部丢弃。
- **截断判定修正**：depth 边界上的叶子节点不再算截断（先 `FindFirst(Children)` 确认确有子元素）。
  修之前每个窗口都报 `truncatedByDepth=true`，警告全是噪声。
- **`click` 失败可见**（`lib/tools.js`）：`snapMarkerPoint` 从「返回裸点」改为「返回判定」，
  `via` 区分 `marker-snapped` / `marker-raw` / `coordinate` / `element`；render 输出四态，
  同时给出 window 与 screenshot 两个坐标系、命中元素名、未吸附时的最近控件偏移与距离。
  此前 marker 路径 `via` 恒为 `coordinate`，吸附成功与失败不可区分，且 `note` 只进 `value`
  不进 model 可见的 render。
- **吸附位移上限**（关键）：旧 `cap = 0.18×min(w,h)≈297px` 允许 163px 高的整条工具栏容器当宿主，
  实测 131 个 marker 里 28 个位移 >60px、18 个 >150px、最大 225px，却报「吸附成功」。
  改为 `hostCap = 0.08×min(w,h)≈132px` + `moveCap = 0.25×hostCap≈48px`：复测 >60px 归零、最大 43px。
- **`nearby` 可用性**：剔除覆盖全窗口的容器（它包含点击点、距离 0，会挤掉真正相邻控件）；
  disabled 控件不再抢首位；不再限定固定半径，近处无控件时如实给最近的几个。
- **网格锚点** `E` 前缀改 `N` 并加 40 个上限：11 列是 A..K，格点已占 E1–E7，补点从 E8 起会被读成
  「第 5 列第 8 行」；补点原本也没有数量上限（注释称 ≤100，实际 `while` 只管格点）。
- **性能**：`GetSupportedPatterns()` 换成按插件实际消费的 8 个 pattern 逐个 `TryGetCurrentPattern`，
  563 个元素从 1681ms 降到 441ms（3.8×）；整次 `get_app_state` 从 2292ms 降到 1535ms。

验证（真实桌面，Win10 / PowerShell 5.1）：
`scripts/local-verify.mjs` P1–P5 逐项通过（P5 多候选解析、P1 中文往返、P3 身份优先/路径可用/陈旧失败、P4 回执坐标）；
惰性树热窗口 `retries=0` 不误触发、`maxDepth:3` 仍报真实截断、`N` 锚点 40 个；
吸附位移对新旧规则对照（旧 28 个 >60px / 最大 225px，新 0 个 / 最大 43px）；
逻辑测试 `scripts/logic-test.mjs` 通过。

> 注：`local-verify.mjs` 的 P1 用例默认选中 `edits[0]`，在资源管理器里那是**搜索框**——
> 它的 `SetValue` 会被搜索建议覆盖，属系统行为。改用地址栏做同一往返即 PASS（`unicode 验收 42` 原样读回）。
> 这是测试选错了控件，不是编码缺陷。

## 0.3.1 — 2026-09-29

- `peerDependencies` 的 `@deepseek-ai/dsh-tools` 由 `^0.1.2-rc.1` 放宽为 `>=0.1.2-rc.1 <0.3.0-0`。原范围上界是 `<0.2.0-0`，在 DSH 0.2.0 系列上不满足，DSH 官方兼容性闸门会判定不兼容并直接跳过本插件，导致内置 Computer Use 整体失效（10 个工具全部不注册）。实测修改前 0.2.0-rc.1/rc.2 判定拒绝，修改后 0.1.7-rc.1、0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2 全部兼容。
- 上界由 `<0.3.0` 收紧为 `<0.3.0-0`：闸门用 `includePrerelease` 语义求值，`<0.3.0` 连 `0.3.0-rc.x` 也放行，等于对未来 0.3 预发布宣称兼容；`<0.3.0-0` 把 0.3.0 的全部预发布挡在外面。
- seam 释放改为异步等待：官方契约 `register(name)` 的 disposer 类型是 `() => Promise<void>`（内部是 cordis effect），`lib/index.js` 的卸载清理改为 `async` 并 `await releaseSeam()`，等注册表真正记录释放后再继续后续清理（cordis 会 await 返回 Promise 的 cleanup）。
- 无运行时行为变更：`lib/tools.js` 对 `@deepseek-ai/dsh-tools` 的 `defineTool` 导入经核对在 0.2.0-rc.1 与 0.2.0-rc.2 均仍导出，工具注册路径不受影响。

验证：闸门逐版本核对通过；`npm test` 43 项全过（`test/seam.test.mjs` 的 `unload` 随异步 cleanup 改为 `await`）；对 profile 实际安装产物运行集成校验，输出 10 个唯一 Computer Use 工具；DSH 0.2.0-rc.1/rc.2 桌面 runtime 实机重载后 10 个工具在线且插件不再被跳过。

## 0.3.0 — 2026-09-24

- 接入 DSH 0.1.7+ 官方 computer-use 契约（`@deepseek-ai/dsh-computer-use` 的 `computerUse` 服务）：注册表存在时以 `mimi-computer-use` 认领独占提供方席位，本插件的 10 个工具成为该部署唯一的桌面操作来源；席位已被其他提供方（如官方 cua-driver）占用时自动让位——撤下工具与系统提示词并记录告警，不再与官方提供方双开桌面工具。注册表缺席（DSH ≤ 0.1.6 或未安装契约包）时行为与 0.2.2 完全一致；注册表在启动后期才挂载时同样完成认领或让位。卸载顺序遵循官方契约：先撤工具与资源、再释放席位。
- 零新增依赖：运行时按服务名探测，不导入官方包（brand 类型仅存在于 TypeScript）。

验证：新增 5 项 seam 回归（无契约直装 / 空位认领与卸载释放 / 占位让位 / 迟到契约让位 / 迟到契约认领），默认 `npm test` 共 43 项全部通过；DSH 0.1.7-rc.1 实机验证认领路径。

## 0.2.2 — 2026-09-14

- UIA 获取失败时只重试原窗口，避免使用同进程其他窗口的元素树执行动作。
- 目标窗口激活失败时停止观察或输入，避免操作落到其他前台窗口。
- 修复全部 10 个工具的取消信号传递；取消可中止光标动画等待和正在执行的内核请求，队列中已取消的请求不会发送。
- 元素点击保留右键、中键、双击和三击语义，仅默认左键单击使用 InvokePattern。
- MCP 观察结果直接返回标准 PNG 图像内容块，同时保留本机截图副本；本机副本写入失败不影响图像返回。
- MCP 单次调用结束时等待审计写入并完整输出响应，避免退出丢失日志或截断大响应。

验证：新增 30 项回归测试，默认 `npm test` 共 38 项全部通过；真实桌面 E2E 未运行。
