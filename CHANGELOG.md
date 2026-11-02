# 更新记录

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
