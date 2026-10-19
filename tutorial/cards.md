# 做一张卡

这一篇从**做一张最小可用的卡**开始，逐字段拆开讲；然后照基础包里的卡加主动、加被动、加光环。
全程只用**文件管理器 + 记事本 + 桌面版界面**，不需要命令行。

> 读完你应该能：写出一个能正常加载、能摆上场、能在对局里生效的卡。

## 0. 先准备一个自己的包

卡必须住在某个**包**里（包就是数据目录下的一个文件夹）。**先启动一次 OpenBaz**，它会自动建好数据目录。

1. 按 **Win + R**，粘贴 `%APPDATA%\OpenBaz\packs` 回车 —— 打开数据目录。
2. 在里面**新建文件夹** `myPack`；再进 `myPack`，新建文件夹 `cards`。
3. 在 `myPack` 里新建一个文本文件，**连扩展名一起**命名为 `pack.yml`，内容：

```yaml
id: myPack
name: 我的卡包
version: 1
engineRange: [{ from: '0.1.0' }]
cards:
  - mySword
```

4. 在 `myPack\cards` 里新建 `mySword.yml` —— 内容见下一节。

> **用记事本保存的两个要点**：① 「另存为」时**保存类型选「所有文件」**，文件名写 `pack.yml`（否则会变成 `pack.yml.txt`）；② 编码选 **UTF-8**（Win10 以后默认就是）。
> 资源管理器里建议打开「查看 → 文件扩展名」，能一眼看出扩展名对不对。

## 1. 最小的一张卡

基础包里最简单的卡是「普通的剑」，全文只有 23 行：

```yaml
# packs/base/cards/plainSword.yml
id: plainSword
name: 普通的剑
version: 1
size: small
cooldown: 3.00
rarity: bronze
description: 一把最普通的剑：行动条满了就砍，没有别的花样。

stats:
  atk: 5

tags: [weapon]

abilities:
  - id: 1
    kind: active
    actions:
      - do: deal_damage
        target: enemy_player
        amount: { ref: self.atk }
```

它只做一件事：**行动条每充满一次，就对敌方玩家造成「攻击」点伤害**。

**把它变成你自己的卡**：把上面这段粘进 `mySword.yml`，并把 `id` 改成 `mySword`、`name` 改成 `我的剑`、`description` 改成你自己的话（第一行注释也一起改掉）。然后回界面点「**重载卡牌**」——卡牌库出现「我的剑」，摆盘里能选中它。

> 卡牌的 `id`、文件名、`pack.yml` 清单**三处要一起改**。这三处不一致是最常见的"卡没出现"原因。

## 2. 每个字段是什么意思

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 首字符字母，其余字母 / 数字 / 下划线（可驼峰）；**必须与文件名一致**，全局唯一 |
| `name` | ✅ | 显示名。也可写成多语言映射：`name: { 'zh-CN': 我的剑, en: My Sword }` |
| `version` | ✅ | 从 1 开始；**改了任何字段就 +1**（旧版本不会被覆盖，注册表按版本隔离） |
| `size` | ✅ | `small` = 占 1 格 / `medium` = 2 格 / `large` = 3 格（每方共 10 格） |
| `cooldown` | ✅ | 行动条充满需要的**秒数**；`-1` = 纯被动 / 纯光环，不进行动条 |
| `rarity` | ✅ | 品阶 id，内置 `bronze` / `silver` / `gold` / `diamond`（也可自定义，见 packs.md） |
| `stats` | ⬜ | 数值表，**整张表可以不写**；不需要攻击就别写 `atk` |
| `description` | ⬜ | 卡面小字（悬浮窗里显示） |
| `tags` | ⬜ | 类型标签，如 `[weapon]`：供筛选、供"按标签选目标"、供"每有一个 X"计数 |
| `abilities` | ⬜ | 效果列表；可以为空（空卡也能放上场，只是不产生效果） |

还有几个选填字段：`slots`（覆盖占格）、`multicast`（多重触发）、`owner`（归属）、`enchantments`（附魔目录）、`inheritOverride`（品质继承），分别在 **[advanced.md](advanced.md)** 与 **[packs.md](packs.md)** 里讲。

> **卡面没有"卡框"字段**：卡框只由品阶决定。**卡面也不能写 `enchant`**：当前生效哪件附魔是"局内状态"，由 `do: enchant` 施加。

## 3. 为什么数值写在 `stats` 里

1. **改数值只改一处**：动作里写 `{ ref: self.atk }`（可简写 `self.atk`），引擎每次结算都读**实时值**——会自动带上局内 buff、附魔加成、光环修正。
2. **别的机制能读到它**：比如"治疗量 = 攻击 + 2"，写成 `{ add: [{ ref: self.atk }, 2] }` 即可。

所以效果数额（伤害 / 治疗 / 护盾 / 持续效果层数）**建议**写引用。写死数字（`amount: 5`）不会拦你，但会报一条 `warn`，而且以后调平衡要满文件找数字。
**带运算符要写表达式**（裸引用简写只认单个 `self.<属性>`）：`{ mul: [{ ref: self.atk }, 1.5] }` = 攻击 × 1.5，`{ add: [...] }` = 相加。

> **不需要攻击的卡，就别写 `atk`**（包括别写 `atk: 0`）：写了它就成了一块"有攻击属性"的卡，攻击类效果会把它算进去。草药瓶、庇护所、纯光环这类卡，`stats` 里只写自己真正用到的键，或者整张表都不写。

## 4. 加一条被动（照「树屋」）

- **主动**（`kind: active`）：行动条满了就执行，**不写** `trigger`。
- **被动**（`kind: passive`）：某件事发生后才执行，**必须写** `trigger`（时机词）。

基础包「树屋」的被动是"有玩家受伤时回血"。照它给我们的剑加一条：

```yaml
id: mySword
name: 我的剑
version: 2
size: small
cooldown: 3.00
rarity: bronze
stats:
  atk: 5
  heal: 5
tags: [weapon]
abilities:
  - id: 1
    kind: active
    actions:
      - do: deal_damage
        target: enemy_player
        amount: { ref: self.atk }
  - id: 2
    kind: passive
    trigger: { event: on_player_damaged }
    actions:
      - do: heal_player
        target: own_player
        amount: { ref: self.heal }
```

要点：

- `trigger: { event: on_player_damaged }` = **任一玩家受到实际伤害之后**（敌我双方都算）。想只在"己方受伤"时触发，要加 `condition`，见 advanced.md。
- **被动条目只写**：`id` / `kind: passive` / `trigger` / `actions`，可选 `condition` 与 `priority`（1–10，数值大者先结算）；`cooldown` 属于整张卡、`everyN` 只属于主动条目，每条能力都要一个卡内唯一的 `id`，`actions` 至少 1 条。

## 5. 纯光环卡（照「维护包」）

有些卡**不出手也有用**：在场期间持续给队友加数值。这类卡三件事：`cooldown: -1`、**不写** `abilities`、写一个顶层 `aura`。

```yaml
id: myBanner
name: 我的旗
version: 1
size: medium
cooldown: -1
rarity: gold
aura:
  select: all_own_cards
  apply:
    - { stat: atk, amount: 10 }
```

- **整张卡没有 `stats`**（维护包就是这样）—— 它不是攻击卡，不需要攻击 / 治疗这些属性。
- `select` = 作用对象（与动作的 `target` 同一套选择器语法）；`apply` = 平铺加减，正数增强、负数削弱；`mul` = 倍率（见 advanced.md）。
- 光环是**派生态**：来源离场，下一个触发帧就失效，不需要"清理"代码。

新建 `cards/myBanner.yml` 贴上这段，并把 `myBanner` 加进 `pack.yml` 的 `cards:` 清单（缩进两格、前面加一个 `-`）。

> ⚠️ `cooldown: -1` 的卡**别写** `kind: active`：它压根不进行动条，那条主动永远不会生效（会报一条 `warn`）。

## 6. 一张卡可以有多条主动

「旧砍刀」每次行动做两件事：先砍一刀，再给自己 +3 攻击。它们共用**同一个行动条**，按**书写顺序**结算：

```yaml
abilities:
  - id: 1
    kind: active
    actions:
      - do: deal_damage
        target: enemy_player
        amount: { ref: self.atk }
  - id: 2
    kind: active
    actions:
      - do: gain_stat
        stat: atk
        amount: 3          # buff 类加值允许写数字
        target: self
```

想做"每 3 次行动才结算一次"或"一次满条打两轮"，用 `everyN` / `multicast`，见 advanced.md。

## 7. 四个最常见的错

| 现象 / 错误码 | 原因 | 怎么改 |
|---|---|---|
| `card.ref.undefined_stat` | 效果里引用了 `stats` 没写的键（如写了 `self.atk` 却没有 `atk`） | 把键加进 `stats`，或改成已有的键 |
| `card.action.no_target` | 动作没写 `target` | 这是 **warn**：引擎按"来源卡自己"处理，多半不是你想要的 —— 补上目标 |
| 效果数额的 `warn` | 伤害 / 治疗 / 护盾写了数字 | 改成 `{ ref: self.<属性> }`，属性写进 `stats` |
| 卡没出现在卡牌库 | 文件名 ≠ `id`，或 `pack.yml` 的 `cards:` 没列它 | 三处对齐（**清单没列 = 不加载**） |

## 8. 验收

回界面点「**重载卡牌**」，看顶栏「**问题 N 条**」：显示 `问题 0 条` 就过了；有 `[warn]` / `[note]` 可以留着（先确认是不是有意的）；有 `[error]` ⇒ 按错误码查 [troubleshooting.md](troubleshooting.md)。
然后去「摆盘」把你的卡放上场，打一局看看。**改完记得把 `version` +1** —— 与别人分享新版本时，这个号码是唯一能区分"哪一版"的东西。

## 9. 下一步

- 想让卡住进一个能分享的包（文件夹结构、品阶、图片、角色）→ **[packs.md](packs.md)**
- 想用技能、附魔、光环、条件、多重触发 → **[advanced.md](advanced.md)**
- 报错看不懂 → **[troubleshooting.md](troubleshooting.md)**
