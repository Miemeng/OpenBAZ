# AGENT.md — Agent 开发规范

> 版本：v0.8
> 适用对象：在本仓库工作的 AI Agent / 自动化开发工具
> 地位：本文档是 Agent 执行任何代码修改前**必须阅读并遵守**的规范；与人类开发者约定冲突时以本文档 + 设计文档为准。
> **执行分工（v0.8）**：本仓库的**所有终端命令由 RW 执行**，Agent 只做文件改动——见 §4.0（硬约束，含对 Agent 的 4 条强制要求）。

---

## 1. 项目概述

异步自走棋卡牌模拟器：基于 YAML 热加载卡牌定义，支持玩家 DIY，确定性可复现的异步自走棋对战模拟。

| 项 | 内容 |
|----|------|
| 技术栈 | TypeScript + YAML；React + Vite 做表现层 |
| 仓库形态 | **单包（single package）**，非 monorepo；边界靠 ESLint 导入限制约束（见 §3 / 框架 §2.5） |
| 核心设计文档 | 《卡牌模拟器框架设计.md》（框架设计 v0.20）、《战斗模拟设计.md》（战斗模拟设计 v0.1）、《模拟模式设计文档.md》、《卡牌设计细化.md》、《用户故事.md》 |
| 工具链 | npm ｜ Node Active LTS（22.18+ / 24 / 26）｜ TypeScript `5.9.3` ｜ Vitest 5 ｜ Vite `^8` ｜ ESLint 10 + typescript-eslint 8（依据见 §4.1 / 框架 §2.5.3） |
| 里程碑 | 见框架设计第 12 节（M1–M7） |

**Agent 在开始任何任务前，必须先阅读上述设计文档，并确认所改内容属于哪个里程碑。**

---

## 2. 不可违背的黄金法则

1. **确定性优先**：给定双方阵容 + 种子，战斗结果 100% 可复现。所有随机必须走 `engine/rng.ts` 的唯一入口，**禁止**在引擎任何地方使用 `Math.random()`、时间戳、`Date.now()` 等不确定性来源。
2. **引擎零依赖**：`engine/` 是纯逻辑包，不允许依赖 Node API、DOM API、网络、文件系统。需要这些能力的代码必须放在 `engine/` 之外。
3. **引擎与表现分离**：客户端（`client/`）与 CLI（`simulator/`）共用同一引擎；表现层不实现任何战斗规则，战斗规则的一切变更只改 `engine/`。
4. **词典驱动**：时机词 / 动作词 / 选择器是封闭词典。新增词条必须同步更新：词典实现、《规则说明书》、《YAML 数据格式规范》、校验器报错建议表。**禁止做"宽松解析"**（解析失败即报错并给出最接近的合法词条建议）。
5. **YAML 优先**：当前阶段只做结构化 YAML（L2），不做 L1 中文卡面文字编译器。
6. **热加载安全**：卡牌/技能文件加载失败不得崩溃、不得覆盖已注册的旧版本；进行中的对局不受影响（注册表版本隔离）。

---

## 3. 仓库形态与目录结构

**仓库形态：单包（single package）** 一个 `package.json`、一份根 `tsconfig.json`、一个 `node_modules`；下面的分层是**目录边界**，不是包边界。原因与拆分触发条件见《卡牌模拟器框架设计.md》§2.5；**未出现该节列出的触发条件前，不得擅自改造成 monorepo / workspace。**

```
project/                          # 单包；边界靠 ESLint 导入限制（§5.4），不靠包
├── package.json                   # 单包清单（type: module；依赖全部精确版本）
├── tsconfig.json                  # Node 侧（engine/ cards/ simulator/）；不含 paths 别名
├── tsconfig.client.json           # 表现层（开 jsx）；.tsx 不被 Node 类型擦除支持，故独立
├── vitest.config.ts               # 测试（environment: node；排除 client/）
├── eslint.config.js               # 模块边界强制（§5.4 的唯一落点）
├── engine/          # 战斗引擎（纯逻辑，零依赖）— 见框架设计 §3
│   ├── types.ts     # 核心类型：Card, BoardCard, PlayerState, BattleState...
│   ├── state.ts     # 状态构建与快照
│   ├── tick.ts      # 行动条主循环（0.2s/tick）
│   ├── events.ts    # 事件系统 + 优先级触发器栈
│   ├── resolver.ts  # 动作原语执行
│   ├── rng.ts       # 种子化随机（mulberry32 / xoroshiro）
│   └── log.ts       # 动作日志
├── cards/           # 卡牌系统：loader / registry / schema / template / glossary
├── client/          # 游戏客户端（表现层，后期；React + Vite）
├── simulator/       # CLI 模拟器
├── packs/           # 卡包数据（内置 core + 外部导入）
├── skills/          # 技能定义（YAML）
├── drafts/          # 自定义模式草稿
├── decks/           # 预置阵容
└── rarities.yml     # 品阶定义
```

**落地状态（v0.15 建立，v0.11 复核）**：上表的配置文件与目录**已建立**；`engine/` 已有 **9 个在用模块**（`rng` / `types` / `state` / `board` / `selectors` / `expr` / `primitives` / `tick` / `log`）+ 一个已被 `primitives.ts` 取代、待删的旧 `resolver.ts`；`simulator/` 有 `run.ts` / `demo-deck.ts`；`cards/` `client/` 及四个数据目录仍只有 `.gitkeep` 占位。骨架期的两只临时探针 `engine/__probe__.ts` / `simulator/__probe__.ts` **已按 §9 第 11 条回收**（见 §5.4 末段）。详细清单与实现细节见框架设计 §2.5.4，零源码期怎么验收见 §2.5.5。**路径约定（v0.16 已统一）**：文档目录已改名为 `docs/`，与 §6 的引用一致；此后新增文档一律放 `docs/`。

**运行边界（v0.13 决议，见框架设计 §2.5）**：`engine/` 与 `cards/` 必须同时能在 Node 与浏览器两种宿主下运行；凡是依赖 Node 能力（文件读写、YAML 加载管线、目录监听、CLI）的代码一律留在 `cards/` 之外或 `cards` 的宿主适配层，**不得反向渗入 `engine/`**。`packs/` / `drafts/` / `decks/` / `skills/` 属于工作区数据（非源码），位于项目根层。

**改动边界**：修改 `engine/` 任何文件 → 必须跑确定性回归测试（见 §7）；修改 `cards/schema` → 必须同步更新 YAML 规范文档；新增原语/时机词 → 按 §6 流程走；**修改任一层对外的导入关系 → 必须同步更新框架设计 §2.5 的依赖方向表**。

---

## 4. 开发命令

**两条工具链，职责分开**（v0.13 决议，见框架设计 §2.5）：**Node 侧**负责引擎、卡牌加载、YAML 校验、CLI 批量模拟；**Vite 侧**只负责表现层（`client/`）。两者共用同一份 `engine/` / `cards/` 源码，不存在第二份实现。

### 4.0 执行分工：命令由 RW 运行（v0.8 明确，硬约束）

**本仓库的终端命令一律由 RW（人类）执行，Agent 不直接运行命令。**

| 分工 | 谁做 | 说明 |
|------|------|------|
| 读文件 / 写文件 / 改配置 / 写文档与源码 | **Agent** | Agent 的全部交付物都是文件改动 |
| `npm install` / `npm run *` / `node *.ts` / `git` / `tsc` 等一切终端命令 | **RW** | 由 RW 在项目根目录的 PowerShell 执行，并把**完整输出**粘回给 Agent |

**理由**：Agent 的执行终端在 `D:\工作文件夹\BazaarSim` 下**不可用**（沙箱禁止向工作区授予写权限，实测报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`），因此 Agent 无法自行建立基线、无法自行验证规则是否生效。

**对 Agent 的强制要求**：

1. **禁止声称"已验证 / 已跑通 / 测试通过"**——Agent 手里没有运行证据。只能表述为"我改了 X，**请你运行 Y 并把输出贴回**"。
2. 需要命令结果时，给出**可直接整段粘贴**的完整命令，并明确说明**期望看到什么**（预期输出 / 预期报错 / 预期退出码），便于 RW 一眼判断是否符合预期。
3. 验证结论的最终确认权在 RW 的输出里。RW 贴回的实测输出是**唯一**的验收证据——这也正是 v0.6 / v0.7 两次修正（`TS18003`、`no-restricted-globals` 误判）得以发生的原因：靠实测输出纠错，不靠推测。
4. 涉及多步验证时，**一次只让 RW 跑一组命令**（见 §9 第 9 条），避免输出互相覆盖、也避免 RW 来回切换。
5. 请全部使用**中文**进行回复，逻辑和工程陈述不允许使用英文。

### 4.1 运行时与构建

```bash
# Node 侧（引擎 / 校验 / CLI）——运行时：Active LTS 线（Node 22.18+ / 24 / 26）
npm install
npm run check:config     # 校验两份 tsconfig 可解析（零源码期唯一有效的"配置验收"）
npm run typecheck        # tsc --noEmit -p tsconfig.json（TypeScript 5.9.3）
npm run typecheck:client # tsc --noEmit -p tsconfig.client.json（与上一条独立，禁止用 && 串联）
npm run lint
npm run test             # vitest run --passWithNoTests
npm run build            # 目前等价于 typecheck，见下方说明

# Vite 侧（表现层，后期）
npm run dev              # Vite dev server（仅 UI；不承载引擎逻辑）
```

**说明**：命令行统一写成 `node simulator/<脚本>.ts`，依赖运行时的 TypeScript 直跑能力；**本仓库依赖该能力，运行时必须是 Active LTS 线**（Node 22.18+ / 24 / 26 均可：类型擦除自 v22.18 / v23.6 起默认开启、v24.12 / v25.2 起 Stable；`.npmrc` 已开 `engine-strict=true`，不在线内直接装不上）。**包管理器是 npm**（`package-lock.json` 必须入库）。**本次骨架搭建时 RW 已卸载全局 TypeScript 7 并改为项目内钉版本**（全局保留也不影响 `npm run typecheck`，项目内 `typescript` 优先；但全局 ts7 会让 `tsc -v` 误报，故仍建议不留）。升级运行时版本属于工具链变更，需先在任务说明中给出理由并等确认（§9 第 3 条）。

**两条踩过的坑（v0.6，实测来自首次 `npm install` 后的基线运行）**：
1. **`typecheck` 不得用 `&&` 串联两个项目**：原写成 `tsc --noEmit && tsc -p tsconfig.client.json --noEmit`，前一条失败会**吞掉后一条的全部输出**——实测只看到 `tsconfig.json` 的报错，client 侧结果未知。现拆为 `typecheck` / `typecheck:client`，需要同时跑时由 CI 显式串联。
2. **零源码期 `tsc` 会报 `TS18003: No inputs were found`**：这不是配置错误，是 `tsc` 对"零输入文件"的既定行为；但会让骨架期的基线假红。**零源码期的验收基线是 `check:config` + `lint` + `test` 三条**（`test` 带 `--passWithNoTests` 才不假红），`typecheck` 等第一个 `.ts` 落地即恢复有效。详见框架设计 §2.5.5。

**`npm run build` 目前只是 `tsc --noEmit` 的别名**——引擎由 Node 直跑、可能根本不需要 emit，emit 与否即待办 P0.5-4b，定稿前不要把它当真实构建。

**工具链版本（v0.14 决议，依据见框架设计 §2.5.3）**：Node 走 **Active LTS 线**｜**TypeScript `5.9.x`**｜**Vitest 5**｜Vite `^8`。判据是**工具链确定性优先**，不是 typecheck 速度优先：**不上 TypeScript 7**（7.0 已是原生 Go 编译器、快 8–12×，但 typescript-eslint 的官方支持区间是 `>=4.8.4 <6.1.0`，**7.0 不在其中**）；**不用 6.x**（npm registry 中 `6.0.0` / `6.0.1` 均不存在，只有 `6.0.0-beta`，即无稳定版可依）。

### 4.2 验证与模拟（CLI）

```bash
node simulator/validate.ts          # 校验全部卡牌/技能 YAML
node simulator/simulate.ts --deckA decks/a.yml --deckB decks/b.yml --seed 42   # 单场
node simulator/simulate.ts --deckA decks/a.yml --deckB decks/b.yml -n 1000     # 批量胜率
node simulator/glossary.ts          # 词条速查表
```

**测试框架：Vitest 5**（须支持确定性回归测试，见 §7）。确定性回归**不得**依赖 Vitest 的快照序列化——hash 一律按 §7 的规范化序列化约定自行计算。

---

## 5. 编码规范

### 5.1 TypeScript

- 严格模式开启；禁止 `any`（确需逃生舱处用 `// eslint-disable-next-line` 并注明理由）。
- **只写可擦除语法（v0.14）**：禁 `enum`、带运行时代码的 `namespace`、构造函数参数属性、装饰器、`import` 别名——详见 §5.4 的单一语法子集，违反会导致裸跑 CLI 失败。
- 引擎内所有数值计算使用 `number`，金钱/百分比不做浮点相等比较。
- 冷却等计时使用秒、两位小数精度（0.01s）；tick = 0.2s，换算只出现在表现层与日志。
- 所有对外暴露的接口必须写 JSDoc，注明：参数、返回值、抛错条件、确定性影响。

### 5.2 YAML 与数据

- 卡牌/技能文件的字段定义以《YAML 数据格式规范.md》为唯一标准；schema 校验器（`cards/schema.ts`）必须与其保持同步。
- 校验错误报告格式：**文件路径 + 行号 + 字段路径 + 原因 + 建议**。
- id 命名规范：小写下划线（`cinder_wolf`）；version 从 1 开始递增，只增不改旧版本。

### 5.3 确定性专项

- 遍历 `Map` / `Set` 前先排序或使用插入序明确的数据结构。
- 浮点运算顺序不得依赖对象遍历顺序。
- 新增任何随机行为时，必须能从种子复现，并在批量模拟中验证分布合理。

### 5.4 模块边界与导入限制（v0.13 决议，v0.14 补语法子集）

单包形态下，框架设计 §2.5 的架构约束**靠 ESLint 导入规则 + 类型检查强制**，不靠包边界。规则的唯一落点是仓库根 ESLint 配置，**禁止靠"记得别这么写"来维持**。

**强制规则**（按 `engine/` / `cards/` 两个 override 块落地）：

| 作用域 | 禁止 | 目的 |
|--------|------|------|
| `engine/**` | `import` 任何 `node:*` 内置模块（运行时） | 黄金法则 2：引擎零依赖、无 Node API |
| `engine/**` | `import`任何第三方包运行时值（`zod` / `js-yaml` 等） | 引擎零依赖 |
| `engine/**` | 运行时 `import` 其他层（`cards/` `client/` `simulator/`） | 依赖方向单向；**仅允许 `import type`** |
| `cards/**` 的纯逻辑部分（`schema` / `registry` / `glossary` / `template`） | `import` `node:*` | 保证浏览器宿主可运行（框架 §2.5） |
| `engine/**` 与 `cards/**` 纯逻辑 | 触碰宿主全局：`window` / `document` / `navigator` / `localStorage` / `sessionStorage` / `fetch` / `process` | 同一份源码要跑在两种宿主（框架 §2.5.2） |
| 全体 | `Math.random()` / `Date.now()` / `new Date()` | 黄金法则 1：确定性 |

**要点**：`import type { ... } from 'cards/types'` 是允许的（类型擦除后不产生运行时边）；只有**运行时导入**被禁。实现上需同时开启 `verbatimModuleSyntax`（或等价配置），保证类型导入在产物里真的被擦除——否则"类型导入"会在浏览器打包时把 Node 侧模块拖进 bundle。

**宿主全局是怎么拦的（v0.17 订正，含一次错误修正的记录）**：用 **`no-restricted-globals`**，写成 `['error', { globals: [window, document, navigator, localStorage, sessionStorage, fetch, process], checkGlobalObject: true }]`。

- **不要用"`languageOptions.globals` 置 `'off'` + `no-undef`"**：`typescript-eslint` 的 recommended 已把 `no-undef` 对 `**/*.ts` 关掉（`@typescript-eslint/eslint-plugin/dist/configs/eslint-recommended-raw.js:36`，`'no-undef': 'off'`）。该写法在骨架期"看起来在生效"，**一旦有真实 `.ts` 源文件就一条都不报**——典型的假绿。上一版文档正是这么写的，现已订正。
- **另一个错误记录**：曾把失败归因于"`no-restricted-globals` 的条目只能是字符串、写对象会让 ESLint 拒绝整份配置"。**这是错的**——该规则的 schema 明确支持 `{ name, message }` 对象条目，并额外提供 `globals` / `checkGlobalObject` / `globalObjects` 三个选项（见 `node_modules/eslint/lib/rules/no-restricted-globals.js:31-93`）。当时没有读规则源码就下了结论，且"修复"引入的假绿比原报错更有害。**教训：ESLint 规则的行为先读 `node_modules/eslint/lib/rules/<rule>.js` 的 `meta.schema` 与 `create()`，再改配置。**
- **该规则的两个有利性质**：① 只报**运行时引用**，类型注解里的同名类型（`Event` / `Window` 等）会被忽略，所以 `fetch`、`document` 这类同时也是 DOM 类型名的不误报；② `checkGlobalObject: true` 连 `globalThis.process` / `self.fetch` 一起报。

**反向用例（改完 lint 配置必须验一遍，验完删除）**：在 `engine/` 下任意 `.ts` 里临时写一行 `const t = process.env.TZ;`，`npm run lint` 必须报 `no-restricted-globals`；在 `cards/schema.ts` 里临时写一行 `import { readFileSync } from 'node:fs'`，必须报 `no-restricted-imports`。**删掉临时行后 lint 必须恢复全绿**——否则说明规则是靠某个 `eslint-disable` 通过的，等于没验。

**单一语法子集（v0.14，硬约束）**：`engine/` 与 `cards/` 纯逻辑要同时对**三条链路**成立——`node` 原生类型擦除（跑 CLI）、Vitest/esbuild（跑测试）、`tsc`（只做类型检查）。因此**只允许"可擦除语法"**：

1. **禁 `enum`、带运行时代码的 `namespace`、构造函数参数属性、装饰器、`import` 别名**——Node 擦除不支持，且 `--experimental-transform-types` 已在 Node 26 移除，没有转换退路（违反则裸跑 CLI 直接抛错）；
2. **源文件导入必须写 `.ts` 后缀**，并开 `allowImportingTsExtensions`（Node ESM 强制要求扩展名；本仓库 `noEmit`，故不用官方推荐的 `rewriteRelativeImportExtensions`——理由见框架 §2.5.3）；
3. **禁 `tsconfig` 的 `paths` 别名**——Node 不读 `tsconfig.json`，别名的导入在 CLI 侧必然失败。替代方案只有两种：相对路径，或 `package.json` 的 `#` subpath imports（唯一不依赖 tsconfig 的别名机制）。**本节上表的 ESLint 规则不负责拦这一条**，靠本约束与类型检查；
4. 开 `erasableSyntaxOnly`（让违规在类型检查阶段就暴露）+ `verbatimModuleSyntax`。

**为什么必须有第 5 条验收**：**Vitest 经 esbuild 转译，会容忍 Node 擦除不支持的语法**——即"测试全绿"不能证明"CLI 能跑"（假绿）。因此 CI 与每次会话基线**必须真实跑一次 `node simulator/*.ts`**（可小规模对局），作为语法在擦除管线下可用的证据。

**实施状态（v0.17 已落地并实测）**：仓库已有 `package.json` / 两份 `tsconfig` / `eslint.config.js` / `tools/check-config.mjs`；两个 override 块 + 四项编译选项**均已建立**。**规则生效证据（RW 实测，探针已回收）**：`npm run lint` 曾命中 `engine/__probe__.ts:7` 的 `node:fs` 导入并报出 `no-restricted-imports`（paths 分支 + patterns 分支各一条），证明 `engine/**` 块真的在跑；`npm run probe:boundary` 曾打印 `probe ok: type-stripping + import type survived`，证明 Node 类型擦除 + `import type` 链路可用；`npm run check:config` 三条断言全绿（含 §2.5.5 之外新增的"加载期陷阱"检测）。

**两项反向用例的状态（均已实测，探针已回收）**：① `node:*` 导入——**已验**（v0.18，RW 实测 `lint` 命中 `engine/__probe__.ts:7`）；② 宿主全局（`process.env.TZ`）——**已验**（v0.19，P0.5-4d 关闭：`no-restricted-globals` 按预期拦下，删除该行后 `lint` 恢复全绿、警告清零）。两项的证据文件都已按 §9 第 11 条删除；**今后要复验只能按上文步骤临时写一行再删**——不要为了"随时能验"把违规行长期留在仓库里。

**注意（v0.11 已回收）**：这两个探针文件**已删除**——`engine/` 内出现 `node:*` 即违规（黄金法则 2）。原回收时机是"第一个真实引擎模块落地之后"，该条件已满足（`engine/rng.ts` 等 9 个模块在位，`typecheck` 不会再退回 `TS18003`）。回收连带处理：`package.json` 的 `npm run probe:boundary` 脚本已删除；`simulator/__probe__.ts` 的职责（给 `tsc` 提供输入）已由 `simulator/run.ts` 承担。**回收后待 RW 复跑**：`npm run lint` 全绿 + `npm run typecheck` 无输出（可直接用 `npm run verify` 一次跑完，见 §7）。

---

## 6. 扩展流程（新增原语 / 时机词 / 选择器）

写真实卡牌时发现表达不了的句式，按以下流程处理，**不得私自加宽松的临时方案**：

1. 在 `docs/失败样例.md`【待建】记录：原始句式、目标效果、现有原语为何表达不了；
2. 提案新原语/词条，写明：语义、参数、对优先级/触发栈的影响、边界情况；
3. 同步更新四处：词典实现、`规则说明书.md`、`YAML 数据格式规范.md`、校验器建议表；
4. 补测试：至少 1 个单卡 YAML 用例 + 1 个确定性回归用例；
5. 在规则说明书"变更记录"登记。

逃生舱 `{ do: 'script', lang: 'lua' }` **禁止实现**（框架设计 §7 明确不建议）。

---

## 7. 测试规范

| 测试类型 | 内容 | 触发时机 |
|----------|------|----------|
| 单元测试 | resolver 各原语、条件表达式、选择器 | 每次修改 engine/ |
| 确定性回归 | 固定阵容 + 固定种子 → 战斗日志快照比对（hash） | 每次修改 engine/ |
| 触发器优先级测试 | priority / 入场时间 / 本家优先 三级排序用例 | 修改 events.ts |
| YAML 校验测试 | 合法样例通过、非法样例报错（文件/行号/字段路径） | 修改 schema |
| 批量模拟冒烟 | 内置卡包全部卡牌两两/随机对打不崩溃 | 里程碑验收 |

**任何 PR 必须附带确定性回归测试通过的证据**（同一 seed 的日志 hash 不变）。

**基线前置**（v0.13，v0.14 扩充，v0.6 修正）：`node simulator/validate.ts` 与"标准对局"尚未实现；M1 完成前，每次会话开始以 `npm run typecheck && npm run typecheck:client && npm run lint && npm run test` 全绿作为基线，**并真实跑一次 `node simulator/<脚本>.ts`（可小规模）**——Vitest 经 esbuild 转译会容忍 Node 擦除不支持的语法，"测试全绿"不能证明 CLI 能跑（§5.4）。**骨架期（尚无任何 `.ts` 源文件）例外**：此时 `typecheck` 必然报 `TS18003`，基线改用 `npm run check:config` + `npm run lint` + `npm run test` 三条（详见框架设计 §2.5.5）。上述两项落地后，§9 第 9 条恢复为以 `validate` 为准。**v0.11 起**：上面这串命令已固化为 **`npm run verify`**（`check:config` → `typecheck` → `typecheck:client` → `lint` → `test` → 裸跑 `node simulator/run.ts --seed 42`），会话开始直接跑它即可。`verify` 只做串联、**不新增任何验收标准**，且失败即停（`&&` 串联，前一条失败后面的不跑）——这与"两条 `typecheck` 必须拆开"不冲突：拆开是为了能单独看某一侧的输出，`verify` 是为了要一个总闸门。

**hash 计算约定**（v0.13，避免自己被自己坑）：确定性回归不能直接 hash 对象或依赖 `JSON.stringify` 的键序。统一做法是：日志先按固定字段顺序**规范化序列化**（显式 field list，不遍历对象键），再对 UTF-8 字节求 hash；`Map` / `Set` 参与序列化前先排序（§5.3）。序列化函数的任何改动都视为**破坏性变更**，必须同步重算全部基准 hash——否则测试会"集体变红"而看不出是引擎变了还是序列化变了。

---

## 8. 文档同步义务

| 改动 | 必须同步更新的文档 |
|------|--------------------|
| 新增/修改动作原语、时机词、选择器 | 规则说明书.md、YAML数据格式规范.md |
| 修改 CardDef / SkillDef / BattleState 类型 | API文档.md、YAML数据格式规范.md |
| 修改触发优先级或战斗主循环 | 规则说明书.md、框架设计.md（决议记录） |
| 修改热加载/注册表行为 | API文档.md |
| 修改任一层的导入关系 / 运行边界（Node 侧 vs 浏览器侧） | 框架设计.md §2.5、AGENT.md §3 / §5.4 |
| 引入或更换运行时、构建、测试、lint 工具链 | 框架设计.md §2.5 表末（工具链决策）与 §2.5.3（决策依据）、AGENT.md §4 / §5.4 / §9 |
| 放宽或收窄可擦除语法子集（`enum`、装饰器、`paths` 别名等） | 框架设计.md §2.5.3、AGENT.md §5.1 / §5.4 |
| 决议待定问题（框架 §13） | 框架设计.md 决议记录 + 规则说明书.md |

文档未同步的 PR 视为不完整。

---

## 9. Agent 工作准则

1. **先读文档，再写代码**；理解不了的规则去框架设计 §13 待定问题清单确认，不要自行臆断。
2. **小步提交**：一个逻辑变更一个提交；不允许"顺手重构"无关代码。
3. **不引入新依赖**（尤其是 engine/ 内）；如确需引入，先在任务说明中给出理由并等待确认。已有依赖清单见框架设计 §2.5。
4. **不修改已定规则**（框架 §5.2 决议记录）；发现设计矛盾时，停止实现并报告矛盾点。
5. **不确定时提问**，不要猜测实现；涉及数值平衡的内容只实现机制、不填平衡数值（数值留 `【平衡待定】` 占位并在回复中说明）。
6. **不改仓库形态**：单包是 v0.13 决议（§3、框架 §2.5）；未出现该节列出的触发条件前，不得引入 workspace / monorepo，也不得为"将来可能拆包"提前建包。
7. 修改完成后，在回复中说明：改了什么、同步了哪些文档、跑了哪些测试及结果。
8. **不许把架构层混进 JSX**：战斗规则、数值结算、随机一律不得写在 `.tsx` / 事件处理函数里；表现层只消费引擎日志（黄金法则 3）。
9. 每次会话开始时先建立基线：**`npm run verify`** 全绿（= `check:config` → `typecheck` → `typecheck:client` → `lint` → `test` → 裸跑 `node simulator/run.ts --seed 42`，见 §7）；手工分条跑时等价于 `npm run typecheck && npm run typecheck:client && npm run lint && npm run test` 全绿，**并真实跑通一次 `node simulator/<脚本>.ts`**（防 Vitest 假绿，见 §5.4）；**零源码期用 `check:config` + `lint` + `test` 代替**（见 §7）；`node simulator/validate.ts` 与标准对局实现后，改用它确认基线（见 §7）。
10. **命令交给 RW 跑（§4.0）**：Agent 不运行终端命令。需要基线或验证结果时，给出可直接粘贴的完整命令 + 预期输出，等 RW 贴回实测结果后再下结论；**在拿到实测输出前，不得声称任何东西"已通过 / 已验证"**。一次只请 RW 跑一组。
11. **临时探针必须回收**：为验证规则而临时添加的违规行 / 探针文件（如 §5.4 的反向用例），验完**必须删除**并在回复中说明已删除；仓库里不得留下无法解释的违规代码或 `eslint-disable`。

---

## 10. 待定问题处理规则

- 框架设计 §13 中的待定项**未决议前不得实现相关机制**；如任务必须触及时，用 ask 向用户确认并在代码中留 `// TODO(decision): 见框架设计 §13-第N条` 标记。
- 每个里程碑结束时，应主动检查待定清单中是否有可关闭项。

---

## 11. 变更记录

| 日期 | 版本 | 内容 | 修改人 |
|------|------|------|--------|
| 10.4 | v0.2 | 初版 | RW |
| 26.10.4 | v0.3 | **仓库形态决议**：明确单包（非 monorepo），§3 改名"仓库形态与目录结构"并补运行边界与拆分触发条件指引（框架 §2.5）；§4 开发命令拆为 Node 侧 / Vite 侧两条工具链（工具链版本留【填写】）；新增 §5.4 模块边界与导入限制（ESLint override + `verbatimModuleSyntax`，`import type` 允许、运行时导入禁止）；§7 补 hash 规范化序列化约定与基线前置；§8 增补运行边界/工具链两类同步义务；§9 增补第 6、8 条（不改仓库形态、规则不进 JSX） | RW（待评审） |
| 26.10.4 | v0.4 | **工具链决议**：§4.1 定 Node Active LTS + TypeScript `5.9.x` + Vitest 5 + Vite `^8`（判据=工具链确定性优先；不上 TS 7 因 typescript-eslint 支持区间 `<6.1.0`，不用 6.x 因 registry 无正式版；依据见框架 §2.5.3）；§1 增工具链行、核心文档改指框架 v0.14；§4.2 测试框架定为 Vitest 5 且明确回归 hash 不依赖 Vitest 快照；§5.1 增"只写可擦除语法"；§5.4 增单一语法子集五条 + 真实 CLI 运行验收（防 Vitest 假绿）；§7 基线扩为 typecheck+lint+test+裸跑 CLI，并修正第 7 条→第 9 条引用；§8 增语法子集同步义务行 | RW（待评审） |
| 26.10.4 | v0.5 | **骨架落地**：§3 目录树补单包配置文件（`package.json` / `tsconfig.json` / `tsconfig.client.json` / `vitest.config.ts` / `eslint.config.js`）与落地状态（各目录仅 `.gitkeep`，无业务源码），并登记 `doc/` 与文档所写 `docs/` 的路径偏差；§4.1 补"项目内 `typescript` 优先于全局、全局 ts7 只会让 `tsc -v` 误报"；RW 已卸载全局 TypeScript 7，项目内钉 `5.9.3`（`--save-exact`，配 `.npmrc`）；实测清单见框架 §2.5.4 | RW（待评审） |
| 26.10.4 | v0.6 | **零源码期验收修正（首次 `npm install` 后实测）**：§4.1 增两条踩坑记录——`typecheck` 禁用 `&&` 串联（前一条失败会吞掉后一条输出，故拆为 `typecheck` / `typecheck:client`）、零源码期 `tsc` 必报 `TS18003`；新增 `check:config` 命令为骨架期基线；§7 与 §9 第 9 条的基线改为"骨架期 `check:config` + `lint` + `test` / 有源码后四条 + 裸跑 CLI"；§3 落地状态补"路径约定已统一为 `docs/`"（RW 已改名） | RW（待评审） |
| 26.10.4 | v0.7 | **宿主全局强制机制订正（RW 实测报错后复核）**：v0.6 的写法（`languageOptions.globals` 置 `'off'` + `no-undef`）**是无效的**——`typescript-eslint` recommended 已对 `**/*.ts` 关闭 `no-undef`（`eslint-recommended-raw.js:36`），有真实源文件后一条不报；改为 `no-restricted-globals`（`{ globals, checkGlobalObject: true }`）。§5.4 重写该段并**完整记录这次误判**：曾错误断言"该规则条目只能是字符串、写对象会让 ESLint 拒绝整份配置"，实际 schema 支持 `{name,message}` 且有 `globals`/`checkGlobalObject`/`globalObjects` 三个选项；新增"反向用例"验证步骤（临时写违规行 → 必须报错 → 删除后恢复全绿） | RW（待评审） |
| 26.10.4 | v0.8 | **执行分工明确（RW 要求）**：新增 **§4.0 执行分工：命令由 RW 运行**——Agent 的执行终端在本仓库不可用（沙箱报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`），故所有 `npm` / `node` / `git` 命令一律由 RW 执行并贴回完整输出，Agent 只做文件改动；含对 Agent 的 4 条强制要求（禁止声称"已验证"、给可整段粘贴的命令 + 预期输出、实测输出是唯一验收依据、一次只跑一组）。§9 新增第 10 条（命令交给 RW + 未拿到输出前不得下结论）与第 11 条（临时探针必须回收）；§1 核心设计文档版本改指框架 v0.17；抬头补执行分工提示 | RW（待评审） |
| 26.10.4 | v0.9 | **《待办》整理**：`docs/待办.md` 历史沿革过长，做一次只压缩已关闭项与版本沿革的整理（已关闭项与 v0.13→v0.25 沿革移入文末「五、历史归档」），开放项与核心规则一字未减；§3 落地状态模块数按实况修正为 10（原写 12 含 `.gitkeep` 误计） | RW（待评审） |
| 26.10.4 | v0.10 | **署名统一**：全仓文档变更记录表的署名由 `ATLAS` 统一为 `RW`（同一人，原两种署名合并）；新增《战斗模拟设计.md》并登记进 §1 核心文档清单；各文档内容均未变、版本号不动 | RW（待评审） |
| — | v0.11 | **探针回收 + 本地 CI 基线（RW 决议，L0 档）**：① 删除骨架期两只临时探针 `engine/__probe__.ts` / `simulator/__probe__.ts`（§9 第 11 条：`engine/` 内不得留 `node:*`）与临时诊断脚本 `tools/diag-lint.mjs`；② `package.json` 删除 `probe:boundary`、新增 **`verify`**——串联 `check:config` → `typecheck` → `typecheck:client` → `lint` → `test` → 裸跑 `node simulator/run.ts --seed 42`（**暂不接 GitHub Actions**，云端 CI 留到有测试用例/多人协作时再谈）；③ §3 落地状态按实况改写（9 个在用模块 + 待删的旧 `resolver.ts`，不再是"无任何业务源码"）；④ §5.4 两项反向用例状态订正为"均已实测、探针已回收"（原文"宿主全局尚未验证"与 P0.5-4d 的实测记录矛盾）；⑤ §7 基线与 §9 第 9 条补 `npm run verify`；⑥ 新增仓库级 `.gitattributes`（`* text=auto eol=lf`）、`.gitignore` 补 `*.out.txt` | RW（待评审） |
