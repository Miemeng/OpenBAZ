# YAML 数据格式规范

> 版本：v0.8（主动 / 被动由 `cooldown` 决定版）
> 依据：《规则说明书 v0.12》《卡牌模拟器框架设计 v0.14》§4、§6、《卡牌YAML模板.yml》v0.3.4（本文档内容未因框架 v0.13 / v0.14 变化，仅更新引用版本号）
> 读者：卡牌创作者（DIY 玩家）、开发者
> 说明：本文档是卡牌/技能/卡包/阵容 YAML 文件的**唯一格式标准**；`cards/schema.ts` 校验器必须与本规范保持同步。词表（时机词/动作原语/选择器/引用）以《规则说明书》《时机表.md》为准，本文档不重复定义。

---

## 1. 总则

1. **热加载**：`packs/**/*.yml`、`skills/*.yml`、`drafts/*.yml` 保存即生效；校验失败不覆盖旧版本，错误报告含文件 + 行号 + 字段路径。
2. **版本隔离**：每张卡/技能以 `version` 注册（id → version → def），进行中的战斗不受新版本影响。
3. **id 规范**：小写字母 + 数字 + 下划线，全局唯一，如 `cinder_wolf`；必须与文件名一致（卡牌贴图约定为 `<id>.png`）；版本从 1 开始只增不减。
4. **封闭词典**：`event` / `do` / `pick` / `ref` / `cmp` / `stat` 均为封闭词表，写错即报错并给出最接近的建议，不做宽松解析。
5. **未知字段**：校验阶段直接拒绝并提示（不做忽略）。
6. **注释**：允许 YAML 注释（`#`），自定义模式生成的模板必须带注释说明。

---

## 2. 卡牌文件（CardDef）

路径：`packs/<pack_id>/<card_id>.yml` 或 `drafts/<card_id>.yml`

### 2.1 完整示例

```yaml
# packs/core/cinder_wolf.yml
id: cinder_wolf
name: 烬狼
version: 1
cooldown: 4.00            # 冷却（秒，必填）：行动条充满周期
size: medium              # small=1格 medium=2格 large=3格，可 slots: N 覆盖
rarity: gold              # 品阶 id = 这张卡的最低品质
stats: { atk: 45 }        # speed 行动条速度倍率缺省 1，一般不修改
tags: [野兽, 火系]

abilities:
  - kind: passive
    priority: 10                # 被动触发优先级（缺省 5，范围 1–10）
    trigger: { event: onPlayerDamaged }   # 玩家受伤时（敌我均广播）
    condition: { cmp: eq, left: { var: player }, right: { ref: enemyPlayer } }  # 仅敌方玩家受伤
    actions:
      - do: gainStat
        stat: atk
        amount: { mul: [self.atk, 0.2] }
        stackLimit: 5
        target: self

  - kind: active              # 主动效果：挂靠在本卡唯一的行动条上
    everyN: 3                 # 选填：仅每第 3 次主动行动时结算（缺省每次充满都结算）
    actions:
      - do: dealDamage
        target: { pick: randomEnemyCard }
        amount: self.atk      # 引用 stats 字段（可写 { ref: self.atk }）；abilities 内禁止数值字面量
```

### 2.2 字段定义

| 字段 | 类型 | 必填 | 默认 | 约束与说明 |
|------|------|------|------|------------|
| `id` | string | ✅ | — | 小写下划线，全局唯一；与文件名一致 |
| `name` | string | ✅ | — | 显示名 |
| `version` | integer | ✅ | — | ≥1，递增；同 id 新版本注册后不覆盖旧版本 |
| `cooldown` | number | ✅ | — | 冷却时间（秒）；= -1 表示纯被动物品（无行动条、无主动行动）；否则必须 > 0，行动条充满周期 = `cooldown × (cdp ÷ 100) ÷ 速度倍率`（cdp 为 stats 约定字段，缺省 100）。**本字段决定这张卡是主动卡还是被动卡**，与 `abilities` 里写没写主动效果无关 |
| `size` | enum | ✅ | — | `small` / `medium` / `large` |
| `rarity` | string | ✅ | — | 品阶 id = 这张卡的**最低品质**，引用 `rarities.yml` |
| `stats` | map | ✅ | — | 见 2.3 |
| `description` | string | ⬜ | 空 | 卡牌描述（设计风味），小字显示在悬浮窗内 |
| `slots` | integer | ⬜ | 由 size 推导（1/2/3） | 覆盖默认占位；≥1 |
| `owner` | string | ⬜ | 本方默认角色 | 卡牌归属角色 id（规则 §17） |
| `frame` | string | ⬜ | 品阶默认卡框 | 自定义卡框（图片资源 id），表现层资源 |
| `multicast` | integer | ⬜ | 1 | 多重触发次数；>1 时卡面标注 *N、悬浮窗标明 |
| `buy_prize` | number | ⬜ | 查 `card_values.yml` | 买入价值（规则 §16） |
| `prize` | number | ⬜ | 查 `card_values.yml` | 当前售价；模拟模式战斗内不变价 |
| `tags` | string[] | ⬜ | `[]` | 类型标签，供筛选与"每有一个X"类效果计数 |
| `hidden_tags` | string[] | ⬜ | `[]` | 隐藏词条（不显示在卡面，供逻辑用） |
| `enchant` | Action[] | ⬜ | `[]` | 附魔常驻效果组（规则 18.7，v0.8 决议：单槽，新附魔覆盖旧的） |
| `inherit_override` | InheritOverride[] | ⬜ | `[]` | 品质继承覆盖（规则 §13.1，v0.9 定稿）：从最低品阶下一阶到最高品阶每阶一段、必须齐全 |
| `abilities` | Ability[] | ⬜ | `[]` | 见第 3 节。**可为空，引擎不因此报错**：`cooldown !== -1` 的卡即使一条 `kind: active` 都没有，也依然是主动卡——行动条充满即"使用该卡"并广播 `afterAction`（可驱动其他物品的被动），只是不产生效果；`cooldown: -1` 的纯被动卡即使写了 `kind: active` 也**完全无效**（不会被使用、不受 `charge` 影响） |

> 已废除字段（校验拒绝并提示）：`baseAction` / `activeAction`（主体效果自定义已废除，规则 §5）；主动效果不得写 `trigger` / `cooldown` / `priority`。

### 2.3 stats 字段

stats 是**开放数值表**：卡牌全部效果数值的唯一来源，`abilities` / `enchant` 通过 `{ ref: self.<stat> }`（可简写 `self.<stat>`）引用（读取含战斗内 buff 的实时值）。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `atk` | number | ✅ | — | 攻击数值：可被 `{ ref: self.atk }` 引用、可被 buff 的数值；**不内置普攻**（规则 §1），要造成伤害必须由效果条目显式写 `dealDamage`；≥ 0 |
| `speed` | number | ⬜ | 1 | 行动条速度倍率；> 0；受加速 ×2 / 减速 ×0.5 / 冰冻 = 0 影响 |
| （自定义字段） | number | ⬜ | — | 自由命名的小写数值字段，供效果引用；常用约定见下 |

常用约定字段（非强制，自定义品阶卡可另起命名）：

| 字段 | 含义 | 字段 | 含义 |
|------|------|------|------|
| `shd` | 护盾数值 | `reg` | 再生数值 |
| `hel` | 治疗数值 | `has` | 加速时长（秒） |
| `bur` | 燃烧数值（灼烧层数） | `sol` | 减速时长（秒） |
| `poi` | 剧毒数值 | `fre` | 冰冻时长（秒） |
| `chg` | 充能时长（秒） | `cdp` | 冷却百分比系数（缺省 100 = 无修正；修正加算，见 2.2 `cooldown`） |

> **书写规则**：`abilities` / `enchant` 内的数值型参数（`amount` / `seconds` / `duration` 等）禁止字面量，必须引用本表字段；字面量只允许出现在表达式内部（系数 / 阈值）与结构性参数（`everyN` / `stackLimit` / `priority` / condition 阈值）。校验器对违规字面量报错并提示应引用的字段名。

---

## 3. Ability 结构

### 3.1 公共字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `id` | integer | ✅ | — | 卡内唯一、不可重复；供 `inherit_override` 按 id 定位覆盖（v0.9 起必填） |
| `kind` | enum | ✅ | — | `passive`（被动）/ `active`（主动效果） |
| `actions` | Action[] | ✅ | — | 见 3.4；至少 1 条 |
| `trigger` | Trigger | 条件必填 | — | 仅 `passive`：必填，见 3.2 |
| `condition` | Condition | ⬜ | 恒真 | 见 3.3 |
| `priority` | integer | ⬜ | 5 | 仅 `passive`：被动触发优先级，数值大先触发；范围 1–10（v0.10 决议） |
| `everyN` | integer | ⬜ | 每次 | 仅 `active`：仅本卡第 N 的整数倍次主动行动时结算；≥ 2 |

- **主动效果（`kind: active`）**：挂靠在本卡唯一的行动条上，行动条充满时按 `abilities` 书写顺序依次触发；**没有** `trigger` / `cooldown` / `priority` 字段——"冷却"就是行动条本身（充满周期见 2.2 `cooldown`）。
- **被动（`kind: passive`）**：挂在卡牌上的触发器，时机词 + 可选条件 + 动作，受《规则说明书》§6.3 入栈结算与单 tick 去重约束。

### 3.2 Trigger（仅 passive / 技能）

```yaml
trigger: { event: onPlayerDamaged }   # 简单时机（时机词封闭词表见《时机表.md》）
```

- `event`：封闭时机词表，见《时机表.md》；表外取值校验拒绝并给建议。
- 主动效果没有 Trigger。

### 3.3 Condition

```yaml
condition: { cmp: lt, left: { ref: ownPlayer.hpPct }, right: 0.3 }
condition:
  all:
    - { cmp: eq, left: { var: player }, right: { ref: ownPlayer } }
    - { not: { cmp: gt, left: { ref: enemyPlayer.hp }, right: 500 } }
```

- `cmp`：`lt / lte / gt / gte / eq / neq`；
- 逻辑组合：`not` / `any` / `all`；
- 表达式 Expr：数字、`{ ref: ... }`（封闭引用表见规则说明书 §8.3）、`{ var: ... }`（事件参数，见《参数表设计.md》）、`{ count: <Selector> }`、`add / sub / mul / div`。

### 3.4 Action

```yaml
- do: gainStat
  stat: atk
  amount: { mul: [self.atk, 0.2] }
  stackLimit: 5
  target: self
```

- `do`：封闭动作原语表（8 个 + 登记待实现的 `enchant`，见《规则说明书 §9》）；
- 各原语参数以规则 §9 为准；`target` 为必填参数（选择器封闭词表见规则 §10），缺失即校验报错；
- 数值型参数（`amount` / `seconds` / `duration` 等）禁止字面量，必须引用本卡 `stats` 字段（见 2.3 书写规则；技能引用本技能 stats）；
- 持续效果（灼烧/剧毒/再生）不是卡面原语：卡面以 `gainStat`（`stat: burn / poison / regen`，目标为玩家）施加层数（规则 §18）；可选 `duration` / `enter` / `exit` 走引擎独立通道（规则 §18.9，v0.10）。

### 3.5 附魔（enchant，规则 18.7）

```yaml
enchant:
  - do: gainStat
    stat: atk
    amount: self.ena   # 引用 stats.ena（禁止字面量）
    target: self
```

- 附魔为**常驻效果组**：存在即持续生效，无时机词 / 条件；每项为动作，结构与 3.4 完全一致。
- 一张卡同时至多一个生效附魔：被施加新附魔时**覆盖**旧附魔，旧效果组全部移除；无槽位、无叠加。

### 3.6 品质继承覆盖（inherit_override，规则 §13.1，v0.9 定稿）

```yaml
inherit_override:
  - rarity: silver        # 从最低品阶下一阶起、到最高品阶每阶一段、必须齐全
    stats: { atk: 10 }    # 增量（delta）：该品阶基础值 = 最低品阶基础值 + 沿途各段增量之和
    abilities:            # 按 id 合并覆盖；未列出的条目原样继承
      - id: 2             # 必须引用本卡 abilities 中已存在的条目 id
        condition: { ... }   # 全写覆盖
        actions: [ ... ]     # 全写覆盖，至少 1 条（kind 沿用被覆盖条目）
```

- **分段齐全**：段的顺序须与合成链一致（默认 `bronze → silver → gold → diamond`）。
- **stats 增量**：只改卡面基础值，**不触碰局外养成等运行时附加数值**（升品不清空养成）。
- **不可覆盖**：`cooldown` / `enchant` / `tags` / 经济字段等一律继承，写在 override 中校验报错。
- 完整四段样例见《卡牌YAML模板.yml》v0.3.4（atk 10 → 20 → 40 → 80）。

---

## 4. 技能文件（SkillDef）

路径：`skills/<skill_id>.yml`

技能与卡牌走同一套校验/热加载/注册表机制，按目录区分；共用第 3 节的 Condition / Action 词表；**技能没有时机词以外的卡牌专属字段**。

```yaml
# skills/ember_oath.yml
id: ember_oath
name: 烬火誓约
version: 1
icon: ember_oath_circle    # 可选，头像两侧的圆形图标资源 id
priority: 8                # 与卡牌被动同台比较的优先级（缺省 5，范围 1–10，v0.10）

stats:                     # 开放数值表（v0.10 新增）：技能效果数值的唯一来源，规则同卡牌 stats（atk 非必填）
  shd: 100                 # 护盾数值
  atk_boost: 10            # 攻击增益数值

trigger: { event: onPlayerDamaged }
condition:
  all:
    - { cmp: eq, left: { var: player }, right: { ref: ownPlayer } }   # 仅己方玩家
    - { cmp: lt, left: { ref: ownPlayer.hpPct }, right: 0.3 }         # 血量低于30%（阈值字面量允许）
actions:
  - do: shield
    target: ownPlayer
    amount: self.shd        # 引用本技能 stats（禁止字面量，规则 §8.2）
  - do: gainStat
    stat: atk
    amount: self.atk_boost  # 引用本技能 stats
    target: { pick: allOwnCards }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `id` / `name` / `version` | — | ✅ | — | 同卡牌规范 |
| `icon` | string | ⬜ | 默认图标 | 头像两侧圆形图标资源 id |
| `stats` | map | ⬜ | `{}` | 开放数值表（v0.10 新增）：技能效果数值唯一来源，引用规则同 2.3；actions 引用 `self.<stat>` 时相应字段必须已定义 |
| `priority` | integer | ⬜ | 5 | 与卡牌被动同台比较；范围 1–10；同优先级时技能后结算（v0.8/v0.10 决议，规则 §12） |
| `trigger` | Trigger | ✅ | — | 同 3.2 |
| `condition` | Condition | ⬜ | 恒真 | 同 3.3 |
| `actions` | Action[] | ✅ | — | 同 3.4；数值型参数一律 `{ ref: self.<stat> }` 引用本技能 stats |

技能校验拒绝的字段：`kind` / `everyN` / `cooldown` 等卡牌专属字段（技能无冷却概念，规则 §12）。

---

## 5. 卡包元信息（pack.yml）

路径：`packs/<pack_id>/pack.yml`（包根目录；完整样例见《包样例.yml》，字段圈定待 RW 评审）

包目录结构（v0.12 修订，RW 决议）：

```
packs/<pack_id>/
├── pack.yml        # 本文件（包定义）
├── rarities.yml    # 品阶定义（自定义品阶包必填；builtin 可省略）
├── cards/          # 卡牌 yml（文件内 id = 文件名）
├── skills/         # 技能 yml（无技能可省略）
└── images/         # 卡图 / 卡框 / 技能图标（png；卡框放本层）
    ├── cards/      # 卡牌贴图：文件名 = 卡牌注册 id.png
    └── skills/     # 技能图标：文件名 = 技能注册 id.png
```

分发格式：整目录打包为 `<pack_id>.zip`（zip 根目录即 pack.yml，不再多套一层文件夹）。

```yaml
# packs/core/pack.yml
id: core                        # ✅ 卡包 id，与目录名一致，全局唯一
name: 核心卡包                  # ✅ 显示名
version: 1                      # ✅ 卡包整体版本，≥1 递增；与单卡 version 独立
description: 内置示例卡包       # ✅ 简介
engine_min: 0.10                # ✅ 兼容的最低引擎/规则版本，低版本拒绝导入
# author / license / homepage / checksum / created_at / updated_at  # ⬜ 见《包样例.yml》

rarities:
  source: builtin               # ✅ builtin = 引擎内置四品阶；自定义品阶包用 rarities.yml（见第 6 节）

cards:                          # ✅ 内容清单：file 相对包根；导入时核对文件存在、文件内 id 一致
  - { file: cards/cinder_wolf.yml,    id: cinder_wolf,    version: 1 }
  - { file: cards/iron_tortoise.yml,  id: iron_tortoise,  version: 2 }
skills:                         # ✅ 规则同 cards；无技能写 []
  - { file: skills/ember_oath.yml,    id: ember_oath,     version: 1 }
assets:                         # ⬜ 资源清单：卡图 / 卡框 / 图标（images/ 下相对路径）
  - images/cards/cinder_wolf.png
  - images/skills/ember_oath.png
# dependencies:                 # ⬜ 依赖的其他卡包（引用其卡牌/技能时声明）
#   - { id: some_pack, minVersion: 2 }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 卡包 id，与目录名一致，全局唯一；导入更新判定依据 |
| `name` / `version` / `description` | — | ✅ | 显示名 / 整体版本（与单卡版本独立）/ 简介 |
| `engine_min` | string | ✅ | 兼容的最低引擎/规则版本（major.minor） |
| `author` / `license` / `homepage` / `checksum` / `created_at` / `updated_at` | string | ⬜ | 来源与分发元信息（见《包样例.yml》，字段圈定待 RW 评审） |
| `rarities` | map | ✅ | `source: builtin` 或包内 `rarities.yml`（第 6 节） |
| `cards` / `skills` | map[] | ✅ | 内容清单：`file`（相对包根）+ `id` + `version`，导入时交叉核对 |
| `assets` | string[] | ⬜ | 表现层资源清单，缺失回退默认卡框、不阻塞 |
| `dependencies` | map[] | ⬜ | 依赖缺失时卡包标记"不完整"，对应卡不可上阵（见模拟模式设计 §4.2） |

---

## 6. 品阶定义（rarities.yml）

路径：`packs/<pack_id>/rarities.yml`（包根；builtin 包可省略，由 pack.yml `rarities.source` 声明；模板见《稀有度YAML模板.yml》）

```yaml
# packs/core/rarities.yml
rarities:
  - { id: bronze,  name: 青铜, color: "#8d6e63" }
  - { id: silver,  name: 白银, color: "#b0bec5" }
  - { id: gold,    name: 黄金, color: "#ffc107" }
  - { id: diamond, name: 钻石, color: "#00e5ff", frame: diamond_frame }
  # 自定义品阶示例：
  # - { id: mythic, name: 传说, color: "#e040fb", frame: mythic_frame }

upgrade: [bronze, silver, gold, diamond]   # 二合一合成链；自定义品阶可扩展
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 品阶 id，被卡牌 `rarity` 引用（= 最低品质） |
| `name` | string | ✅ | 显示名 |
| `color` | string | ✅ | 十六进制颜色 |
| `frame` | string | ⬜ | 卡框资源 id，缺省用纯色卡框 |
| `upgrade` | string[] | ⬜ | 合成链（按序二合一） |

品质继承：高品阶卡牌以最低品阶卡面为基础继承数值，有变化的部分按品阶分段增量覆盖（`inherit_override`，见 3.6 与规则 §13.1，v0.9 定稿）；合成在模拟模式不体现。

---

## 7. 阵容文件（deck）

路径：`decks/*.yml`

```yaml
# decks/demo.yml
sideA:
  hp: 1000
  skills: [ember_oath, second_wind]
  cards:
    - { id: cinder_wolf, slot: 0 }
    - { id: iron_tortoise, slot: 3 }
sideB:
  hp: 1000
  skills: [tidal_guard]
  cards:
    - { id: storm_crow, slot: 1 }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `sideA` / `sideB` | map | ✅ | — | |
| `sideX.hp` | number | ✅ | — | 初始血量（maxHp 取初始值） |
| `sideX.skills` | string[] | ⬜ | `[]` | 技能 id 列表 |
| `sideX.cards` | map[] | ✅ | — | `{ id: 卡牌id, slot: 起始格 }`；占连续 `slots` 格 |

校验规则：slot 合法（0–9 且不越界占满所需连续格）、卡牌/技能 id 已注册、同侧无重叠。

---

## 8. 草稿模板（drafts/）

由自定义模式 `template.ts` 生成，带注释说明（全字段版见交付文件《卡牌YAML模板.yml》）：

```yaml
# drafts/my_card.yml（模板骨架）
id: my_card          # 请改为唯一 id
name: 新卡牌
version: 1
cooldown: 5.00       # 冷却（秒，必填）：行动条充满周期
size: small          # small / medium / large
rarity: bronze       # 品阶 id = 最低品质
stats: { atk: 10 }   # speed 行动条速度倍率缺省 1
tags: []
abilities: []
```

草稿校验通过后可选"移入卡包"（复制至 `packs/<pack_id>/`）；草稿与正式卡同 id 冲突时的上阵优先级【待定，建议草稿优先并标注】。

---

## 9. 校验规则汇总

| 类别 | 规则 |
|------|------|
| 词表 | event / do / pick / ref / cmp / stat 均在封闭词表内，否则报错+建议 |
| 类型 | 字段类型不符即拒绝；未知字段拒绝并提示 |
| 数值 | `cooldown > 0 或 = -1`、`stats.atk ≥ 0`、`stats.speed > 0`、`everyN ≥ 2`、`version ≥ 1`、`priority ∈ [1, 10]`（v0.10 起） |
| 效果数值 | abilities / enchant / 技能 actions 内数值型参数禁止字面量，必须 `{ ref: self.<stat> }`（或裸字符串 `self.<stat>`）引用已定义的 stats 字段（技能引用本技能 stats）；字面量仅限表达式内系数 / 阈值与结构参数 |
| 主动效果 | 禁止 `trigger` / `cooldown` / `priority`；`everyN` 仅 `kind: active` 可用 |
| 被动 | `trigger` 必填 |
| 引用 | rarity 引用已注册品阶；卡牌/技能 id 已注册；`self.<stat>` 引用的字段必须在 stats 中定义 |
| abilities id | 每条 ability 的 `id` 必填、卡内唯一（v0.9 起） |
| 品质继承 | `inherit_override` 各段 rarity 须沿合成链严格递增、从最低品阶下一阶到最高品阶每阶一段齐全；`abilities` 引用的 id 必须存在；`stats` 增量必须为数值；`cooldown` / `enchant` / `tags` / 经济字段出现在 override 中即报错 |
| 技能 | 拒绝 `kind` / `everyN` / `cooldown` 等卡牌专属字段；`self.<stat>` 引用本技能 stats 中已定义字段 |
| 持续效果通道 | `gainStat` 目标为玩家且 `stat ∈ {burn, poison, regen}` 时，可选 `duration` / `enter` / `exit`（规则 §18.9）；通道参数仅在此场景允许 |
| 附魔施加 | `do: enchant` 已登记但**实现搁置**（规则 §9.9）：校验直接拒绝并提示"暂未实现" |
| 已废除 | `baseAction` / `activeAction` 报错并提示已废除 |
| 错误报告 | 文件路径 + 行号 + 字段路径 + 原因 + 建议 |

---

## 10. 版本管理规则

1. 修改卡牌任何字段 → `version` +1；旧版本保留在注册表供进行中战斗与日志追溯；
2. 热加载失败不覆盖旧版本，状态栏回显错误；
3. 卡包整体版本与单卡版本独立；
4. 导入卡包时本地同 id 卡版本更高 → 提示并默认保留本地。

---

## 11. 变更记录

| 日期 | 版本 | 内容 | 修改人 |
|------|------|------|--------|
| 26.10.1 | v0.1 | 模板初版（依据框架 v0.4 §6） | RW |
| 26.10.3 | v0.2 | 对齐《规则说明书 v0.6》《框架设计 v0.7》：`cooldown` 升为顶层必填字段、stats 收敛为 atk + 选填 speed；主动效果废除 trigger/cooldown/priority、新增 everyN 字段；废除 baseAction/activeAction；新增 description 字段；rarity 明确为最低品质；补全全部【填写】占位 | RW（待评审） |
| 26.10.3 | v0.3 | 对齐《规则说明书 v0.7》《框架设计 v0.8》：stats 开放为自定义数值表（atk 必填 + speed 选填 + 约定字段 shd/hel/bur/poi/reg/has/sol/fre）；确立效果数值书写规则（数值型参数禁止字面量、必须 `{ ref: self.<stat> }` 引用，支持裸字符串简写，2.3 / 3.4 / 第 9 节同步）；`cooldown = -1` 定义为纯被动物品 | RW（待评审） |
| 26.10.3 | v0.4 | 对齐《规则说明书 v0.8》《框架设计 v0.9》：附魔字段统一命名 `enchant`（EnhanceSlot → EnchantDef，移除 slotId；2.2 / 2.3 / 3.5 / 第 9 节同步）；附魔单槽覆盖规则落定（一张卡同时至多一个附魔，新覆盖旧，3.5 示例改为 stats 引用） | RW（待评审） |
| 26.10.3 | v0.5 | 对齐《规则说明书 v0.9》《框架设计 v0.10》：新增约定字段 `chg`（充能时长）与 `cdp`（冷却百分比系数，缺省 100 修正加算），充满周期公式更新（2.2 / 2.3）；`abilities` 公共字段新增必填 `id`（卡内唯一，供 inherit_override 定位，3.1 / 第 9 节）；附魔明确为常驻效果组（3.5）；新增 3.6 品质继承覆盖 `inherit_override`（分段齐全 / stats 增量 / abilities 按 id 全写覆盖，第 9 节校验同步）；技能同优先级表述改为后结算（4.x） | RW（待评审） |
| 26.10.3 | v0.6 | 对齐《规则说明书 v0.10》《框架设计 v0.11》：`priority` 缺省 5、范围 1–10（3.1 / 4.x / 第 9 节）；SkillDef 新增 `stats` 开放数值表，示例改为引用式书写（4.x）；持续效果通道参数 `duration` / `enter` / `exit`（3.4 / 第 9 节，规则 §18.9）；`do: enchant` 登记待实现、校验暂拒绝（3.4 / 第 9 节，规则 §9.9）；第 5 节 pack.yml 按《包样例.yml》重写（目录结构 cards/ skills/ images/、rarities.source、分发元信息）；第 6 节 rarities.yml 路径移至包根、品质继承待定关闭 | RW（待评审） |
| 26.10.4 | v0.7 | 对齐《框架设计 v0.12》：第 5 节 images/ 目录修订——`images/cards/`（卡牌贴图）与 `images/skills/`（技能图标）二级目录，文件名 = 注册 id.png；卡框仍放 images/ 根层；assets 示例同步（RW 决议，同步《包样例.yml》） | RW（待评审） |
| 26.10.4 | （引用更新） | 依据行改引《框架设计 v0.13》，随后随工具链决议更新为《框架设计 v0.14》；本规范内容未变，版本号与正文均不动，仅记录引用关系已核对 | RW（待评审） |
| 26.10.5 | v0.8 | 对齐《规则说明书 v0.12》：**主动 / 被动只由 `cooldown` 决定**——2.2 的 `cooldown` 行补"本字段决定这张卡是主动卡还是被动卡，与 `abilities` 里写没写主动效果无关"；`abilities` 行由"必须至少含一条 `kind: active`、缺则引擎开局报错"（v0.7 之后的一版草案）**改为"可为空、引擎不因此报错"**：`cooldown !== -1` 的卡没有主动效果也照常使用并广播 `afterAction`，`cooldown: -1` 的卡写了 `kind: active` 也完全无效、不受 `charge` 影响 | RW |
| — | （署名统一） | 署名由 "ATLAS" 统一为 "RW"（同一人，原两种署名合并）；内容未变、版本号不动 | RW |