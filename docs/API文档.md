# API 文档 — 引擎与卡牌系统对外接口

> 版本：v0.3（对齐规则 v0.10 / 框架 v0.14 / 规范 v0.7 版；新增宿主边界说明）
> 依据：《卡牌模拟器框架设计 v0.14》§2.5、§4、§9、§11，《YAML数据格式规范 v0.7》，《模拟模式设计文档》§5
> 读者：客户端开发者、CLI 开发者、接入方
> 说明：`engine/` 包与 `cards/` 注册表是客户端与 CLI 的**唯一依赖面**；本文档未列出的内部函数不保证稳定。

---

## 1. 总览

```
┌──────────────────────────────────────────────┐
│  调用方：client/（表现层）  simulator/（CLI）    │
├──────────────────────────────────────────────┤
│  EngineApi   （战斗入口：validate / runBattle）  │
│  CardRegistry（数据入口：卡牌/技能查询、热加载） │
└──────────────────────────────────────────────┘
```

**约定**

- 引擎同步返回结果，不抛业务异常；一切可预期问题（校验失败等）以返回值表达；
- 所有接口满足确定性：同输入同输出，不依赖系统时间；
- TypeScript 类型为准（`engine/types.ts`），YAML 字段定义见《YAML 数据格式规范.md》。

---

## 2. EngineApi — 战斗入口

```typescript
// engine/ 暴露
interface EngineApi {
  listCards(): CardListItem[];
  listSkills(): SkillListItem[];
  validateSetup(input: BattleInput): ValidationError[];
  runBattle(input: BattleInput): BattleOutcome;
  // 预留：runBattle 可返回惰性日志读取器，回放器按需拉取（大日志场景）
}
```

### 2.1 listCards — 卡牌全量列表

**用途**：卡牌列表渲染（含品阶、标签筛选，见模拟模式设计 §3.1）。

**参数**：无。

**返回**：`CardListItem[]`

```typescript
interface CardListItem {
  id: string;
  version: number;
  name: string;
  size: 'small' | 'medium' | 'large';
  slots: number;
  cooldown: number;        // 秒；-1 = 纯被动物品（规则 §5）
  multicast: number;       // 多重触发次数，缺省 1
  rarity: string;          // 品阶 id（= 最低品质）
  frame?: string;          // 自定义卡框资源 id
  stats: { atk: number; speed?: number; [stat: string]: number };  // 开放数值表（规范 2.3）
  tags: string[];
  packId: string;          // 来源卡包 id（注册表登记，导入时写入）
}
```

**错误**：不抛错；注册表为空返回 `[]`。

---

### 2.2 listSkills — 技能全量列表

**用途**：技能选择弹层（头像两侧圆形图标配置）。

**参数**：无。

**返回**：`SkillListItem[]`

```typescript
interface SkillListItem {
  id: string;
  version: number;
  name: string;
  icon?: string;
  priority: number;        // 缺省 5，范围 1–10
  // 触发器与动作的回显文本（框架 §9 加载回显格式），供 UI 展示
  summary: string[];
}
```

---

### 2.3 validateSetup — 摆盘与引用校验

**用途**：开始模拟前校验（客户端禁用开始按钮 + 错误定位，见模拟模式 §4.4）。

**参数**：`BattleInput`（见 2.4）。

**返回**：`ValidationError[]`，空数组 = 通过。

```typescript
interface ValidationError {
  code: string;            // 见 §5 错误码表
  message: string;
  path?: string;           // 字段路径，如 "sideA.cards[2].slot"
  side?: 'A' | 'B';
}
```

**规则**：摆盘几何（越界/重叠/占格）、卡牌/技能 id 注册状态、品阶与 `self.<stat>` 引用、`inherit_override` 分段齐全性、不完整卡包拦截（缺失依赖说明）。

---

### 2.4 runBattle — 单场战斗结算

**参数**

```typescript
interface BattleInput {
  seed: number;
  sideA: SideInput;
  sideB: SideInput;
}

interface SideInput {
  hp: number;              // maxHp 取初始 hp
  skills: string[];        // 技能 id 列表（数量无上限）
  cards: { cardId: string; slot: number }[];
}
```

**返回**

```typescript
type BattleOutcome =
  | { ok: true; result: 'winA' | 'winB' | 'draw'; ticks: number; log: ActionLogEntry[] }
  | { ok: false; errors: ValidationError[] };
```

**说明**

- 同 `seed` + 同阵容 → 结果与日志 100% 一致（确定性回归测试的比对基准）；
- 触发 MAX_TICK（180s / 900 tick）时判平局，平局判我方（sideA）胜，日志正常完整；
- 直接调用且输入非法时返回 `{ ok: false, errors }`，**不尽力运行**（v0.2 决议）；调用前建议先 `validateSetup` 以获得错误定位。

---

## 3. CardRegistry — 数据入口与热加载

```typescript
class CardRegistry {
  private cards: Map<string, Map<number, CardDef>>;   // id → version → def
  private skills: Map<string, Map<number, SkillDef>>;

  get(id: string, version?: number): CardDef | undefined;        // 缺省取最新版本
  getSkill(id: string, version?: number): SkillDef | undefined;
  onReload(cb: (id: string, def: CardDef | SkillDef) => void): void;
  onError(cb: (errors: ValidationError[]) => void): void;        // 热加载/导入失败上报（v0.2 决议）
  summary(id: string): string[];                                  // 加载回显文本（§3.3 格式）
}
```

### 3.1 get / getSkill — 按 id 取定义

| 项 | 说明 |
|----|------|
| `version` 缺省 | 返回该 id 最新版本 |
| 指定 `version` | 返回精确版本（进行中战斗与日志追溯用） |
| id 不存在 | 返回 `undefined`，不抛错（v0.2 决议，与引擎"不抛业务异常"约定一致） |

### 3.2 onReload / onError — 热加载回调与失败上报

> **宿主边界（框架 §2.5.2）**：`CardRegistry` 与 `cards/schema` 是**纯逻辑**（不引用 `node:*`，浏览器宿主可运行）；文件监听与磁盘读取属于**宿主适配层**（Node 侧），由 `packs/` `drafts/` 的文件源适配器负责，把解析并校验通过的定义交给注册表注册。因此"监听"不是 `CardRegistry` 的职责，而是其上游。

- 监听 `packs/**`（cards/ skills/ rarities.yml / pack.yml）与 `drafts/*.yml`（机制见框架 §9 第 1 条：倾向 `node:fs.watch`，最终取决于运行时版本）；
- 校验成功 → 以新 version 注册并触发 `onReload` 回调；
- 校验失败 → 不触发 `onReload`、不覆盖旧版本；错误经 `onError` 上报，由状态栏/事件展示（v0.2 决议接口形态）；
- 进行中的战斗不受回调影响（版本隔离）。

### 3.2.1 卡包导入 —— Node 侧专属能力

导入/导出卡包（zip 解包、目录遍历、`pack.yml` 清单核对、按清单校验后注册、失败整包回滚）依赖文件系统，**只在 Node 宿主可用，不属于浏览器宿主的能力面**。浏览器宿主下的卡牌数据来源见框架 §2.5.2 推论 2（经 Node 侧中介提供）。**待办（见《待办.md》P0.5 第 5 项）**：确定宿主适配层的类名与接口签名后补入本节。

### 3.3 加载回显格式（状态栏 / 日志用，由 `summary(id)` 生成）

```
已加载 烬狼 v2:
  [被动 P10] 敌方玩家受伤时 → 自身攻击 +20%（0/5 层）
  [主动] 行动条充满时 → 对随机敌方卡牌造成等同于攻击的伤害
已加载 技能 烬火誓约 v1:
  [技能 P8] 己方玩家受伤时，若血量<30% → 护盾+100，全体己方卡牌攻击+10
```

---

## 4. 核心数据结构（engine/types.ts）

### 4.1 CardDef / SkillDef

与《YAML 数据格式规范》第 2、3、4、3.6 节一一对应，运行时形态：

```typescript
interface CardDef {
  id: string;
  version: number;
  name: string;
  description?: string;      // 风味描述
  size: 'small' | 'medium' | 'large';
  slots: number;
  cooldown: number;          // 秒，必填；-1 = 纯被动物品
  rarity: string;            // 最低品质品阶 id
  frame?: string;
  stats: { atk: number; speed?: number; [stat: string]: number };  // 开放数值表（cdp 缺省 100）
  multicast?: number;        // 缺省 1
  buy_prize?: number;
  prize?: number;
  enchant?: Action[];                    // 附魔常驻效果组（规则 18.7）
  tags?: string[];
  hidden_tags?: string[];
  abilities: Ability[];                  // 条目须带卡内唯一 id
  inherit_override?: InheritOverride[];  // 品质继承覆盖（规则 §13.1）
}

interface SkillDef {
  id: string;
  version: number;
  name: string;
  icon?: string;
  stats?: { [stat: string]: number };   // 开放数值表（v0.10 新增；效果数值唯一来源）
  trigger: Trigger;
  condition?: Condition;
  actions: Action[];
  priority?: number;                     // 缺省 5，范围 1–10
}

// 运行时
interface SkillInstance {
  skillId: string;
  side: 'A' | 'B';
  useCount: number;         // 统计/日志用，无机制含义
}
```

### 4.2 战斗状态

```typescript
interface BattleState {
  seed: number;
  tick: number;                          // 0.2s/tick；MAX_TICK = 900
  players: [PlayerState, PlayerState];
  cards: BoardCard[];
  board: (number | null)[][];            // board[side] = 长度 10 的数组，值 = instanceId
  rng: Rng;
  log: ActionLogEntry[];
  triggerStack: PendingTrigger[];
  result?: 'winA' | 'winB' | 'draw';
}

interface BoardCard {
  instanceId: number;
  cardId: string;
  cardVersion: number;
  side: 'A' | 'B';
  slot: number;
  buffs: Buff[];                         // { stat, delta, source, expiryTick, stackCount }
  cardEffects: CardEffect[];             // 加速 / 减速 / 冰冻（见 4.6）
  destroyed: boolean;                    // destroy 失效（仍占位）；repair 复原
  actionGauge: number;                   // 行动条进度
  actionCount: number;                   // 主动行动已执行次数（everyN 计数依据）
  queuedTriggers: number;                // 本 tick 超出一次的触发积累数，逐 tick 顺延
}

interface PlayerState {
  side: 'A' | 'B';
  hp: number;
  maxHp: number;
  shield: number;                        // 单一护盾池（规则 §9.4）
  effects: StatusEffect[];               // 持续效果通道实例（见 4.6）
  skills: SkillInstance[];
}

// 持续效果通道实例（规则 §18.9）
interface StatusEffect {
  kind: 'burn' | 'poison' | 'regen';
  stacks: number;
  duration?: number;                     // tick 数；缺省常驻
  source: string;
  enter?: Action[];                      // 进入效果
  exit?: Action[];                       // 退出效果
}
```

### 4.3 动作日志（回放唯一数据源）

```typescript
interface ActionLogEntry {
  tick: number;
  type: LogEventType;
  actor?: number;            // instanceId（玩家事件缺省）
  target?: number | 'A' | 'B';
  payload: Record<string, unknown>;
}

type LogEventType =
  | 'battleStart' | 'battleEnd'
  | 'beforeAction' | 'action' | 'afterAction'        // 主动行动阶段
  | 'damage' | 'heal'                                 // 玩家血量变动（含灼烧/剧毒/再生净值）
  | 'shieldGain' | 'shieldBreak'
  | 'gainStat' | 'applyStatus' | 'charge'
  | 'destroy' | 'repair'
  | 'statusTick'                                      // 持续效果周期结算，payload.kind 区分 burn/poison/regen
  | 'statusEnter' | 'statusExit'                      // 通道进入 / 退出效果
  | 'trigger'                                         // 触发器结算（被动/技能），payload.event = 时机词
  | 'enchant';                                        // 附魔覆盖（规则 §9.9 实现前不会产生）
```

主要 payload 约定（完整参数语义见《参数表设计.md》）：

| type | payload 关键字段 |
|------|------------------|
| `action` | `card`、`slotIndex`、`attackCount`（multicast 序次）、`damageDealt` |
| `damage` | `player`、`amount`（实际扣血）、`shieldAbsorbed`、`damageType`（normal/burn/poison）、`source` |
| `heal` | `player`、`amount`、`cleansedBurn`、`cleansedPoison` |
| `gainStat` | `card?`、`player?`、`stat`、`delta`、`stackCount`、`source` |
| `applyStatus` | `card`、`status`（haste/slow/freeze）、`duration`、`source` |
| `trigger` | `event`、`sourceId`（instanceId / skillId）、`sourceSide`、`pendingCount` |
| `statusTick` | `player`、`kind`、`stacks`（结算前）、`value`（本次伤害/回复） |
| `battleEnd` | `winner`（'A' / 'B' / 'draw'，平局按我方胜上报）、`ticks` |

回放渲染映射表见模拟模式设计 §4.5；**新增事件类型为兼容变更，修改已有 payload 为非兼容变更**。

---

## 5. 错误码表

| code | 含义 | 触发场景 |
|------|------|----------|
| `E_SCHEMA` | YAML 校验失败 | 字段缺失/类型不符/词表外词条 |
| `E_DICT` | 封闭词表外词条 | event / do / pick / ref / cmp / stat 写错（附建议） |
| `E_REF` | 引用不存在 | rarity / cardId / skillId / `self.<stat>` 未注册 |
| `E_LITERAL` | 数值字面量违规 | abilities / enchant / 技能 actions 内数值型参数未引用 stats（规范 2.3） |
| `E_PRIORITY` | priority 越界 | 取值不在 1–10 |
| `E_ABILITY_ID` | abilities id 缺失/重复 | 必填未写或卡内重复（v0.9 起） |
| `E_OVERRIDE` | inherit_override 非法 | 分段缺失/乱序、id 引用不存在、stats 增量非数值、书写了不可覆盖字段 |
| `E_CHANNEL` | 通道参数滥用 | duration/enter/exit 用在非 burn/poison/regen 场景 |
| `E_NOT_IMPL` | 已登记未实现 | `do: enchant`（规则 §9.9，实现搁置） |
| `E_SLOT` | 摆盘几何非法 | 越界 / 重叠 / 占格不足 |
| `E_DEPS` | 卡包依赖缺失 | 引用其他卡包卡牌而其未加载 |
| `E_VERSION` | 版本冲突 | 导入卡包版本低于本地 / engine_min 高于引擎 |
| `E_SKILL_FIELD` | 技能非法字段 | 技能写 `cooldown` / `kind` / `everyN` 等 |

错误报告统一格式：文件路径 + 行号 + 字段路径 + 原因 + 建议。

---

## 6. CLI API

```bash
# 单场：给定种子跑一场，输出完整日志
node simulator/simulate.ts --deckA decks/a.yml --deckB decks/b.yml --seed 42

# 批量：n 场统计胜率分布
node simulator/simulate.ts --deckA decks/a.yml --deckB decks/b.yml -n 1000

# 词条速查表（时机/动作/选择器/引用速览）
node simulator/glossary.ts

# 校验全部卡牌/技能/卡包 YAML
node simulator/validate.ts
```

| 命令 | 输出 | 退出码 |
|------|------|--------|
| simulate 单场 | 结果 + 逐 tick 日志（或日志文件路径） | 0 正常；1 校验失败；2 运行时错误 |
| simulate 批量 | 胜率分布表 | 同上 |
| validate | 每文件通过/失败 + 错误明细 | 0 全绿；1 存在失败 |
| glossary | 词表清单 | 0 |

---

## 7. 版本与兼容性

- 引擎 API 版本 = 本文档版本（当前 v0.2），与规则说明书版本同步推进；卡包 `pack.yml.engine_min` 高于引擎规则版本时拒绝导入（`E_VERSION`）；
- `CardDef` / `SkillDef` 增加可选字段为兼容变更；修改已有字段语义或删除字段为非兼容变更，需 bump 版本并更新本文档；
- 战斗日志格式：新增事件类型为兼容变更；修改已有事件 payload 为非兼容变更。

---

## 8. 变更记录

| 日期 | 版本 | 内容 | 修改人 |
|------|------|------|--------|
| 26.10.1 | v0.1 | 模板初版（依据框架 v0.4 §4/§9/§11） | RW |
| 26.10.3 | v0.2 | 对齐《规则说明书 v0.10》《框架设计 v0.11》《规范 v0.6》：CardDef 补 cooldown/description/multicast/enchant/hidden_tags/inherit_override/经济字段，stats 改开放数值表；SkillDef 补 stats、priority 缺省 5；BoardCard 移除 cooldowns/summonDepth、补 destroyed/cardEffects/actionCount/queuedTriggers；PlayerState 补 shield/effects（StatusEffect 通道字段）；日志事件类型删 summon、补全枚举与 payload 约定；runBattle 非法输入返回 ok:false；get 未命中返回 undefined；新增 onError/summary 接口；错误码补 E_LITERAL/E_PRIORITY/E_ABILITY_ID/E_OVERRIDE/E_CHANNEL/E_NOT_IMPL；补全全部【填写】 | RW（待评审） |
| 26.10.4 | v0.3 | 对齐《框架设计 v0.13》§2.5：§3.2 补宿主边界说明（`CardRegistry` / `cards/schema` 为纯逻辑，文件监听属 Node 侧上游适配层，监听机制改指框架 §9 第 1 条）；新增 §3.2.1 卡包导入标注为 Node 侧专属能力并预留适配层接口待办 | RW（待评审） |
| 26.10.4 | （引用更新） | 依据行改引《框架设计 v0.14》（v0.14 仅新增 §2.5.3 工具链决策，不影响本文档接口定义）；版本号与正文均不动 | RW（待评审） |
| — | （署名统一） | 署名由 "ATLAS" 统一为 "RW"（同一人，原两种署名合并）；内容未变、版本号不动 | RW |
