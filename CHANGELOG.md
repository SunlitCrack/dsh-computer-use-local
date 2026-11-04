# 更新记录

## 0.3.2-local.23 — 2026-11-03

修回执文案的单位错配。`score`（峰值像素差，0–255）和 `threshold`（所需偏离格数，0–2304）量纲不同，旧回执却打印成：

```
Screen CHANGED (score 67.7 vs threshold 8)
```

读起来像「67.7 没过 8 这条线」。这是把阈值语义从「亮度地板」改成「格子计数」时的遗留。

新回执把三个量各带单位列出，并明确指出 threshold 管的是哪个：

```
Screen CHANGED (peak 58, 168 cells, conn 0.49; needs 8 cells)
Screen unchanged (peak 0, 0 cells; needs 8 cells)
```

同时 `deviation` / `connectivity` 此前只存在于 `shouldReobserve` 的返回值里，没有透出到工具结果与 schema，模型看不到判定依据。现已补上。

### 测试
**83 条断言全绿**，新增一条锁回执文案（断言不得出现 `vs threshold`、必须出现 `N cells` 与 `needs M cells`）。
## 0.3.2-local.22 — 2026-11-03

收尾。修正一处注释粘连（上轮删旧注释时留下的合并残留，`signature` 的 JSDoc 被并到行尾）。

### 九轮复核结论：可用

| 项 | 状态 |
|---|---|
| 阻断 | 无 |
| 严重 | 无 |
| 轻微 | 2 条（注释粘连已修；`cellCount` 锁测试在 3 浮点布局下无法区分 `/3` 与 `64*36`，保留作为 stride 变更哨兵） |

### 实机验证（活的窗口，非导出帧）

Qoder diff 窗口灰度滚动 **4/4 检出**，其中 2 次由新增的 `text-change` 通道触发：

| 滚动 | devCount | 面积 | conn | 判定 |
|---|---|---|---|---|
| 1pg | 167 | 7.2% | 0.49 | CHANGED (`text-change`) |
| 0.5pg | 136 | 5.9% | 0.66 | CHANGED (`text-change`) |
| 0.25pg | 164 | 7.1% | 0.73 | CHANGED (`structural-change`) |
| 0.1pg | 135 | 5.9% | 0.70 | CHANGED (`text-change`) |

判据不再依赖「窗口恰好有饱和颜色」。

### 新通道的残余风险已扫描

**低对比度不误报**：300 格方块 V=5/10/15（13% 面积）全部 `dev=0` → unchanged。进度条微动、抗锯齿、hover 残留不会触发。

**随机噪声按算术不可能进入**：`conn ≈ 2p`，面积 ≤15% 时 `conn ≤0.30 < 0.45`。

**`conn>=0.70` 老判据会放过小面积成片变化**（进度条动、spinner 转、caret 闪）。这是合理判断——那些场景元素确实在变，树可能失效。默认探针下真实 caret 只占 1 格，被 `devCount<8` 挡住。

### 九轮定型路径

```
v1–v5   全局统计量（HSV 加权和 / 亮度梯度 / top5-mean / 中位数-P99 / 标准差）—— 六次被否
v6–v16  带符号残差 + 连通性
v21     补上面积维度，覆盖细碎文字移动
v22     收尾
```

最后一条能成，关键在**用真实帧而不是合成构造**。此前两轮修错方向，都是因为合成点阵的邻接结构与真实文字完全不同（`conn 1.67` vs `0.49`）。

### 仍存在的结构性上限

探针 160×90 → 64×36 网格，1px 文字在格内只剩 1/6 信息。这是所有文字类判据反复失败的共同根因。要彻底解决需要提高探针分辨率，但那会改变延迟预算，属于产品决策，不在本轮范围内。

### 测试
**82 条断言全绿**。
## 0.3.2-local.21 — 2026-11-03

**低饱和内容下的细碎文字滚动漏判，这一轮真正修好了。** 关键不是又一个特征，而是拿到了真实帧。

### 前两轮为什么失败

| 尝试 | 失效原因 |
|---|---|
| `minV`（格内最暗像素） | 真实内容 98.7% 的格子本来就有暗像素，文字滚过去时 |Δ| 只有 43–49 |
| `darkCount`（格内暗像素计数） | 每格只采样 2–3 像素，量化太粗：文字位移读 0.25、噪声读 1.000，方向相反 |

两次都是**在特征层打补丁**，都用合成点阵验证，而合成点阵的邻接结构与真实文字完全不同：

```
规则点阵（我的构造）    conn = 1.67  ← 连续行
真实 Qoder diff 文字    conn = 0.49  ← 不连续窄列
```

### 真实帧给出的答案：看面积，不看特征

reviewer 导出了真实帧（`qoder-*.rgb`，160×90 rgb24）。实测：

| 场景 | devCount | 面积占比 | conn |
|---|---|---|---|
| 真实 Qoder diff 滚动 ×3 | 135–168 | **5.9–7.3%** | 0.49–0.70 |
| 噪声 ±40 | 443 | 19.2% | 0.39 |
| 噪声 ±60 | 860 | 37.3% | 0.73 |

**文字只碰窗口的一小片，噪声碰得到处都是。** 面积才是区分量。

新增通道：

| 顺序 | 条件 | 结论 | reason |
|---|---|---|---|
| 1 | `maxC >= 40` | changed | `chroma-change` |
| 2 | `devCount < 8` | unchanged | `uniform-change` |
| 3 | `conn >= 0.70` | changed | `structural-change` |
| 4 | **`面积 <= 15%` 且 `conn >= 0.45`** | **changed** | **`text-change`** |
| 5 | 其余 | unchanged | `scattered-change` |

### 验证（真实帧，非合成）

| 帧 | 灰度 | 彩色 |
|---|---|---|
| 1pg | CHANGED (`text-change`) | CHANGED (`chroma-change`) |
| 0.5pg | CHANGED (`text-change`) | CHANGED (`chroma-change`) |
| 0.1pg | CHANGED (`text-change`) | CHANGED (`chroma-change`) |

六种情况全部检出，不再依赖「窗口恰好有颜色」。

### 同时清理

`lib/observe-gate.js` 里有一整块描述 `STRONG_CONTRAST`/`minV` 通道的注释，而那个常量与通道都已删除。它会误导人以为文字已被覆盖。已删除。

### 测试
**82 条断言全绿**，新增用真实测得统计量驱动的 `text-change` 用例。
## 0.3.2-local.20 — 2026-11-03

修一个确定性计算错误，并撤回两条无效判据。

### 阻断：`cellCount` 用错了除数

签名扩到每格 4 个浮点后，`changeStats` 仍写着 `a.length / 3`：

```
签名长度 9216 / 3 = 3072 格（实际 2304）
gridH = round(3072/64) = 48（实际 36）→ 读取越界
```

实测后果（三色带场景）：`median` 偏 3 倍（-43.33 应为 -130.00），`devCount` 多算 47%。

**为什么测试全绿**：越界读产生 NaN，而 `Math.abs(NaN - median) >= 18` 为 `false`，NaN 不被计数；`median` 的索引 `floor(3072/2)=1536` 又恰好落在真实数据内。纯属侥幸。

改为从网格常量推导 `GRID_W * GRID_H`，并补锁测试（三色带断言 `devCount === 1548`、`median ≈ -100`）。

### 撤回两条无效判据

这两条都是为了救「稀疏文字在低饱和内容下的滚动漏判」，实测都无效：

| 尝试 | 机理 | 为什么无效 |
|---|---|---|
| `minV`（格内最暗像素） | 笔画被平均掉的是均值，最暗值应保留 | 真实内容 **98.7% 的格子本来就有暗像素**，文字滚过去时 `|ΔminV|` 只有 43–49 |
| `darkCount`（格内暗像素计数） | 计数比极值多保留分布 | 每格只采样 2–3 像素，计数过于量化：文字位移与噪声都读出 1.000 |

签名回到每格 3 个浮点（h/s/v），判据回到三条：色度 → 偏离格计数 → 连通性。

### 如实记录的边界

**细碎文字在低饱和内容上滚动，可能判 unchanged。** 灰色主题编辑器、终端、单色表格会受影响。彩色内容不受影响——色度分支会先触发。

这条限制已写入工具描述，不再声称「已覆盖文字」。真实窗口 36 对 0 漏判全部由色度判定，`conn` 在窗口对上零执行，这一点也一并写明。

### 测试
**81 条断言全绿**，新增三色带算术锁测试。
## 0.3.2-local.19 — 2026-11-03

修 `maxAbs >= 100` 对真实文字无效的问题。复核给出了**结构性原因**：64×36 网格 + 格内平均会把 1px 笔画抹平，`maxAbs` 上限只有 53，永远够不到 100。上一版那条判据只对「连续粗笔画」生效，而那种形状 `conn` 本来就能判——判据自相矛盾。

### 根因在签名，不在判据

实测（160×90 探针）：

| 形态 | 格内覆盖率 | maxAbs（均值通道） |
|---|---|---|
| 整格填满 | 100% | 210 |
| 格内 1px 竖线 | 40% | 105 |
| **格内 1px 单点（真实文字）** | **1/6** | **53** |

1px 笔画进 2.5×2.5 的格子后，均值从 250 只降到 197——差异 53。**任何基于格内均值的统计量都拿不到 100。**

### 修法：签名增存每格最小值

`signature()` 从每格 3 个浮点（h/s/v）扩到 **4 个**，第四个是格内**最暗像素** `minV`。笔画被平均掉的是均值，但笔画自己的像素值（40）在 `minV` 里活下来。

`changeStats()` 新增 `maxMin` = 两帧间 `minV` 的最大变化。强对比例外改用 `maxMin`：

| 场景 | maxAbs（均值） | **maxMin（最暗像素）** |
|---|---|---|
| 稀疏 1px 文字 | **53**（无效） | **210**（有效） |
| 虚线分隔 | 75 | 150 |
| 噪声 ±20 | 22 | 31 |
| 噪声 ±60 | 65 | 94 |

判据的判别力从「无效」变成「有效」：文字 210 vs 噪声 ≤94，中间有 116 的余量。

### 判据最终形态

| 顺序 | 条件 | 结论 | reason |
|---|---|---|---|
| 1 | `maxC >= 40` | changed | `chroma-change` |
| 2 | `devCount < 8` | unchanged | `uniform-change` |
| 3 | `maxMin >= 100` | changed | `high-contrast-change` |
| 4 | `conn < 0.70` | unchanged | `scattered-change` |
| 5 | 其余 | changed | `structural-change` |

### 代价

签名内存从 2304×3×4 = 27.6 KB 增至 2304×4×4 = 36.9 KB，每窗口基线多 9 KB（上限 32 个窗口，总量仍 < 1.2 MB）。`signature()` 的 `Math.max` 计算在采样循环内，实测探针耗时无可见变化。

### 已知边界（不变）

`+/-80` 以上的密集噪声 `maxMin` 也 ≥125，会通过第 3 条。屏幕捕获走 GDI BitBlt 无传感器噪声（空转实测 devCount=0），该场景不可达。

### 测试
**82 条断言全绿**，新增 1px 笔画回归测试（同时断言 `maxAbs < 100` 而 `maxMin >= 150`，防止再退回均值通道）。
## 0.3.2-local.18 — 2026-11-03

修 `conn` 对细碎文字类真实变化的漏判（复核实测：真实 Qoder 差异视图滚动，彩色 conn 0.57、灰度 0.47，靠色度分支才没漏）。

### 判据最终形态：按顺序问两个问题

| 顺序 | 条件 | 结论 | reason |
|---|---|---|---|
| 1 | `maxC >= 40` | changed | `chroma-change` |
| 2 | `devCount < 8` | unchanged | `uniform-change` |
| 3 | `maxAbs >= 100` | changed | `high-contrast-change` |
| 4 | `conn < 0.70` | unchanged | `scattered-change` |
| 5 | 其余 | changed | `structural-change` |

第 3 条是本轮新增。连通性能区分「一个区域动了」和「椒盐噪声」，但**分不清细碎文字**——代码 diff、终端输出、表格数字列都是稀疏单格变化，conn 落在噪声带（真实 Qoder 差异视图 0.47）。区别在**对比度**：文字是全对比绘制（实测 maxAbs 210），捕获噪声是低幅度。

于是不再用单一判据，而是按顺序问两个问题：**有全对比的边缘吗？** 没有的话，**偏离格成片吗？**

### 已知边界

`±60` 幅度的密集噪声 conn=0.73、maxAbs=65，两条判据都不拦。但屏幕捕获走 GDI BitBlt，没有传感器噪声（实测空转 devCount=0、maxAbs≤1），这个场景在真实桌面不可达。

### 真实窗口验证的一个说明

45 对真实窗口全部由 `chroma-change` 判定——真实窗口之间普遍有色度差异，所以 `conn` 和 `maxAbs` 两条判据**在窗口对上没有被执行**。它们的作用域是「同一窗口内的内容变化」，那类场景由合成标定覆盖。
## 0.3.2-local.17 — 2026-11-03

`check_screen_change` 的判据经过五轮否决后定型，并修掉一个让全部努力在生产环境失效的缺陷。

### 阻断：生产阈值为校准值的 5 倍

`observeGate.threshold` 在 `tools.js` 里默认 **40**，而 `observe-gate.js` 把它映射成 `residualCells`（"需要多少个偏离格"），校准值是 **8**。

这个 40 是它当年作为「0–255 亮度地板」时留下的。语义改了、默认值没跟着改，于是：

- 生产环境实际门槛比校准值高 5 倍
- 三轮反复修的「遮罩 + 小对话框」（devCount 24–32）在真实插件里**仍然漏判**
- 单测全绿，因为所有用例走的是模块默认值 8，没有一条驱动工具层的默认值

改为 8，并补一条会红的锁测试：用 14×7 面板造出 24 个偏离格——恰好在 8..39 之间，只有正确的默认值能通过。负向验证：把默认改回 40 立刻变红。

### 判据最终形态：带符号残差 + 连通性

| 条件 | 结论 | reason |
|---|---|---|
| `maxC >= 40` | changed | `chroma-change` |
| `devCount < 8` | unchanged | `uniform-change` |
| `conn < 0.70` | unchanged | `scattered-change` |
| 其余 | changed | `structural-change` |

`conn`（连通性，邻接偏离格对数 / 偏离格数）从 0.85 降到 **0.70**：0.85 会漏掉虚线分隔（conn 0.84）和小幅文字移动；0.65 以下独立噪声开始误报。0.70 落在噪声上限（0.58）与真实变化下限（0.84）之间。

### 之前六个版本的失败原因

每一版都用某个全局统计量概括整帧，而「树是否还有效」是局部问题：

| 版本 | 判据 | 怎么失效 |
|---|---|---|
| v1 | HSV 加权和 | 灰噪声在静止画面得 43 分 |
| v2 | 亮度 + 梯度加权 | 两个不同窗口 5.5、一行文字 11.2，双向失败 |
| v3 | top5 / mean | 可证恒等于 1/面积，覆盖 >1/3 窗口的变化全漏 |
| v4 | 中位数 / P99 | 60 处一级断崖；P99 索引丢弃顶端 23 格 |
| v5 | 标准差 | 遮罩 + 120×72 对话框只有 sd 4.42，漏判 |
| v6 | 中位数 + 无符号偏离计数 | 分栏互换的 +200/-200 取绝对值后抵消；且依赖网格相位 |
| **v7** | **带符号残差 + 连通性** | — |

### 实测性能（本机桌面）

| 操作 | 耗时 |
|---|---|
| `pixel_probe` 热态中位 | **133ms** |
| `get_state maxDepth=15` 中位 | **752ms** |
| 加速比 | **约 5.7 倍** |

### 准度（真实桌面动作）

| 动作 | 结果 |
|---|---|
| 静置 600ms | unchanged ✓ |
| 滚动 1 页 | changed（conn 1.00）✓ |
| 上滚 1 页 | changed（conn 0.97）✓ |
| 窗口被遮挡 | `foreground=false` → changed（occluded）✓ |
| 滚动 0.3/0.5 页 | unchanged，位移未跨格，已知取舍 |

### 已知边界

- 覆盖约 99.7% 以上的变化与均匀变换在构造上不可区分
- 两个区域各自均匀、变化量差 < 36 时 `devCount` 归零（元素未移动，树仍有效）
- 1 格孤立变化（`devCount < 8`）会漏，这是数量阈值的固有取舍

### 测试
**86 条断言全绿**（新增生产阈值锁测试）。
## 0.3.2-local.12 — 2026-11-03

延迟优化（P19–P21）及其复审修复。前十二版都在修正确性，这一版第一次动性能。

### 实测结论：观察成本与树的规模无关

`list_apps` 75ms；`get_state maxDepth=0` 72ms；`maxDepth=1` **832ms**；记事本 3 个元素也要 863ms。
**820ms 是 UIA 附着窗口 + 展开第一层子节点的固定成本**，`maxNodes`/`maxDepth` 预算调不动它。
此前"降预算省 10 倍"的判断是错的——那次测到的 345ms 是 `truncated=true`，树提前中断，省的是工作量不是开销。

### Added
- `check_screen_change` 工具（P21）：~100ms 像素探针，让调用方在画面没变时跳过 ~800ms 的 `get_app_state`。
  实测 84–101ms vs 820ms。它不做 UIA 遍历、不设 `observationRequired`，**不能用于验证动作**。
- `pixel_probe` 内核 action：抓全窗后缩略（`CopyFromScreen` + `DrawImage`）；**默认不抢占前台**，返回 `foreground` 标志，遮挡时判 `occluded`。
- `lib/observe-gate.js`：HSV 签名 + **分布判据**（`dvP99` / `dvMed` / `dcP99`）。第四版设计，前三版均被实测否决，见 LOCAL-PATCHES.md。
- `lib/tool-surface.js`：`OFFICIAL_TOOL_NAMES`(10) / `LOCAL_TOOL_NAMES`(1) / `ALL_TOOL_NAMES`，`buildTools` 末尾断言三者与实际注册表一致。
- `fx.response` 配置（P20）：光标 spring 响应时间，钳制 `[0.25, 3.0]`，默认 1.4。
- `observeGate.threshold/width/height` 配置，默认 **40** / 160 / 90。

### Fixed
- P19：`local-verify.mjs` 的 P1 用例假失败。选择器匹配不到动态命名的搜索框（`" 在 xxx 中搜索"`）就回退到地址栏，
  写地址栏等于导航；回查又按 `automationId` 匹配，而搜索框和地址栏都是 `TextBox`。改为按 `path + name` 双条件。
- F1：`shouldReobserve` 的 `no-baseline` 分支不返回 `signature`，导致基线永远建不起来，门控恒答"变了"。
- F2：`score: undefined` 让宿主把整个 value 视为 undefined 并拒绝调用；`window: null` 违反 schema。改用 `-1` 与 `{}`。
- F3：`Invoke-PixelProbe` 曾用 `CopyFromScreen` 直接写入小位图——那是**左上角裁剪**，不是缩略。
  900×700 窗口只改左上角以外的内容，探针判定 `0.00 unchanged`。
- S2：近中性色的 hue 退化，1 LSB 噪声得 43–45 分（阈值 12）。hue 项改按饱和度淡出。
- S3：最小化窗口恒报 unchanged。补 `IsIconic` 检查。
- S4：探针拍遮挡物。补 `Activate-Window`。
- S5：`fx.response` 默认值时也总在 payload 里传，破坏"官方路径字节级一致"。
- `test/seam.test.mjs`、`test/duplicate-guard.test.mjs` 的 `names.length === 10` 改为 `ALL_TOOL_NAMES.length`。

### 测试
- `test/output-schema.test.mjs` 增 3 条 `check_screen_change` 用例（此前该工具零覆盖）。
- **63 条断言全绿**（原 59 + 4）。

## 0.3.2-local.11 — 2026-11-02

复核从四个方向攻击隔离守卫，三条穿过去了；均已修复，并各自补了会红的用例。

- **守卫原本只在加载期跑一次**：在其后追加一行 `Add-Type -AssemblyName System.Windows.Forms`，
  守卫依然「通过」，而 `Invoke-Action` 向焦点窗口真的发出了 4 次按键，测试同时报 16/16 全绿。
  现改为**每个用例执行前**都检查（由 `Capture-Outcome` 调用），并有用例断言它运行次数 >1——
  只在加载期跑一次的检查与注释无异。
- **只查了 4 个方法名**：真实 `CuNative` 通过 `SetCursorPos` 移指针、`keybd_event` 发按键，两者都不在原名单里
  （实测：mock 带上 `SetCursorPos` 后产生 4 次真实鼠标事件）。改为枚举 mock 的**实际方法**而非信任名单，
  并用 `GetMethods()`——`GetMethod(name)` 遇重载会抛 `AmbiguousMatchException`，原先的 `catch {}` 把它变成了静默通过。
- **COM 是类型检查看不见的通道**：晚绑定的 Windows Script Host Shell 对象无需加载程序集即可发按键。
  内核目前完全不使用 COM（已核实），所以这是防将来误用；夹具若引用该路径将拒绝加载，
  扫描自身源码时会先剥掉守卫函数本身，避免匹配到自己。
- 修正 `TreeScope` 判断：`Subtree` 含 `Element`，故 `scope & (Children|Descendants|Subtree)` 会让
  单独的 `Element` 也返回子元素。真实 UIA 中 `Element` 就是元素自身，返回空。现只判断 `Children|Descendants`。

三个新机制各配一条用例，均已反向验证：删掉守卫、删掉 `HasChildren` 门、删掉禁用名单，
都会让**具名用例**变红而非保持绿色。`reverse-check` 现覆盖 9 项，全套测试 59/59。

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












