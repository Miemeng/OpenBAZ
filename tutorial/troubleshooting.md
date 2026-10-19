# 排错：报错怎么读、怎么改

DIY 时 90% 的问题都能在界面的「问题」清单里直接看到答案。这一篇讲三件事：**报错怎么读**、**常见错误码是什么意思**、**几个反复出现的坑**。

## 1. 三种级别，只有一种会拦住你

| 级别 | 含义 | 会不会拦住加载 |
|---|---|---|
| `[error]` | 这条数据不合法，**不会被加载** | ✅ 会（那张卡 / 那个包不进卡池） |
| `[warn]` | 能跑，但**很可能不是你想要的** | ❌ 不会，照常执行 |
| `[note]` | 只是提醒（比如"清单里没列这个文件"） | ❌ 不会 |

所以：**先清 `[error]`，再逐条看 `[warn]` 是不是有意为之**，`[note]` 扫一眼就够。

## 2. 一条报错怎么读

改完任何文件，回界面点右上角「**重载卡牌**」，然后看顶栏那行统计：

```text
卡包 3 个 · 卡牌 16 张 · 技能 6 个 · 问题 2 条
```

"问题"就是全部级别加在一起的数量。下面会逐条列出，每条长这样：

```text
[error] card.ref.undefined_stat  packs/myPack/cards/mySword.yml:14  引用未定义的属性：self.atk
```

依次是：**级别 + 错误码 + 文件:行 + 说明**。按错误码去第 3 节的表里查"怎么改"。
（`[warn]` / `[note]` 的行也这样读，只是不影响加载。）

## 3. 常见错误码对照

| 错误码 | 人话 | 怎么改 |
|---|---|---|
| `yaml.syntax` | YAML 语法错 | 看行号：多半是缩进不一致、用了 Tab、或冒号后面少空格 |
| `schema.invalid` | 结构不合法（未知字段 / 类型不对 / 必填缺失） | 看后面的字段路径；**未知字段一律拒绝**（拼错的键不会"被忽略"） |
| `pack.manifest` | `pack.yml` 本身有问题，或"文件与 `id` / 文件夹与包 `id` 对不上" | 看提示：清单写法、`engineRange`、空包、技能包写了 `owner`、**卡牌 id 与文件名不一致** 等 |
| `pack.duplicate_id` | 两个包用了同一个 `id` | 改包文件夹名 + `pack.yml` 的 `id` |
| `pack.rarity.duplicate` / `pack.rarity.upgrade_unknown` | 品阶 id 重复 / 合成链引用了没登记的品阶 | 品阶 id 唯一；`upgrade` 链只允许内置四档 |
| `pack.owner.invalid` | `owner` 既不是 `common` 也不是合法 id（**warn**） | 写 `common` 或某个角色 id |
| `card.ref.undefined_stat` | 引用了**本卡 `stats` 里没写**的键 | 要么加进 `stats`，要么改成已有的键 |
| `card.ref.unknown_stat` | 引用了不存在的属性名 | 属性名拼错，或写了不支持的字段 |
| `card.stats.unknown_key` | `stats` 里有没登记的键（**warn**） | 多半是拼错（比如把 `shield` 写成 `shild`）；那个名字引擎不认识，写了也不会有任何效果 |
| `card.stats.atk_negative` / `card.stats.speed_non_positive` / `...cdp...` | `atk` 为负 / `speed`、`cdp` 必须 > 0 | 改成正数；`speed` / `cdp` 不调就别写 |
| `card.rarity.unknown` | 品阶没登记 | 用内置四档，或先在 `rarities.yml` 里登记 |
| `card.action.no_target` | 动作没写 `target`（**warn**） | 引擎按"来源卡自己"处理，多数情况要补上目标 |
| `card.selector.unknown` | 选择器名字不在词表里 | 13 条缩写：`self` / `own_player` / `enemy_player` / `all_players` / `all_own_cards` / `all_enemy_cards` / `all_cards` / `random_own_card` / `random_enemy_card` / `adjacent_to_self` / `adjacent_left_self` / `adjacent_right_self` / `event_card` |
| `card.action.player_target_forbidden` | 只作用于卡牌的原语选到了玩家 | `apply_status` / `charge` / `destroy` / `repair` / `enchant` 的目标必须是卡牌 |
| `schema.invalid`（`deal_damage` + 卡牌目标） | 伤害不能作用于卡牌 | 卡牌没有血量；伤害只能 `own_player` / `enemy_player` |
| `card.action.duration_not_allowed` | `duration` 用错了地方 | 只有 `gain_stat` + 玩家 + `burn/poison/regen` 这一条通道接受它 |
| `card.ability.passive_no_trigger` / `card.ability.active_has_trigger` | 被动没写 `trigger` / 主动写了 `trigger` | 被动补时机；主动删掉 `trigger` |
| `card.ability.event_not_broadcast` | 时机词引擎不广播（**warn**） | 目前尚未广播的是 `before_action` / `battle_end`；换一个已广播的词 |
| `card.ability.every_n_not_active` / `priority_not_passive` | 字段放错了地方 | `everyN` 只给主动、`priority` 只给被动 |
| `card.cooldown.passive_with_active` | `cooldown: -1` 却写了主动能力（**warn**） | 那条主动永远不会生效：要么给行动条，要么去掉 `kind: active` |
| `card.enchant.*` | 附魔目录问题（id 重复 / 缺 `name` / 三块全空） | 每件附魔要有唯一 `id`、`name`，且 `aura` / `stats` / `actions` 至少一样 |
| `card.aura.empty` / `card.aura.forbidden_stat` / `card.aura.player_mul_forbidden` | 光环没内容 / 用了禁用的属性位 / 给玩家用了倍率 | 见 [advanced.md](advanced.md) 第 8 节 |
| `card.skill.hero_unknown` | 技能的 `heroes` 写了不存在的角色 | 写 `common` / `sp`，或已注册的角色 id |
| `hero.init_hp_non_positive` / `hero.max_hp_less_than_hp` | 角色血量 ≤ 0，或上限小于初始血量 | 修 `initHp` / `initMaxHp` |
| `deck.*`（`hero.unknown` / `card.unknown` / `skill.unknown` / `enchant.unknown` / `stats.forbidden_key` / `hp.max_less_than_hp`） | **阵容文件**（`decks/*.yml`）引用了不存在的 id，或写了不允许的字段 | 改阵容文件；`cards[].stats` 里不能覆盖 `speed` / `cdp` |

> 没列到的码：按 `<域>.<对象>.<问题>` 看名字基本能猜；每条后面的"说明"才是准的。

## 4. 五个反复出现的坑

1. **缩进**：只用**空格**、每层 2 个，别混用 Tab。`abilities:` 下面少一个空格，整份文件都会读错。
2. **三处同名**：卡牌 / 技能是"文件名 = 文件内 `id`"；角色是"文件夹名 = 文件名 = 文件内 `id`"；包是"文件夹名 = `pack.yml` 的 `id`"。
3. **大小写**：`id` 区分大小写，`plainSword` 和 `plainsord` 是两个不同的 id。
4. **图片命名**：卡图 `images/cards/<card_id>.png`、技能图标 `images/skills/<skill_id>.png`、角色头像固定 `avatar.png`。**图错了不报错**，只是显示不出来 —— 所以"图不显示"别翻 YAML，先看文件名。
5. **`engineRange` 版本号**：必须写全三段并**加引号**（`'0.1.0'`）。写成 `0.1` 会被读成数字，直接报 `pack.manifest`。

## 5. 卡没出现在卡牌库

按这个顺序查：

1. 包是不是放在 `%APPDATA%\OpenBaz\packs\<包文件夹>\`？（按 Win + R 粘贴路径即可打开）
2. 文件是不是放在这个包的 `cards\` 下？
3. 文件名和文件内的 `id` 一致吗？
4. `pack.yml` 的 `cards:` 清单里**列了它**吗？（**清单没列 = 不加载**，只记一条 `note`）
5. 这个包的 `engineRange` 含当前引擎版本吗？（界面顶栏能看到引擎版本号）
6. 改完点过「**重载卡牌**」吗？

## 6. 对局跑到一半中止

这说明数据**加载**通过了，但运行期遇到处理不了的情况。典型有两种：

- **目标类型不匹配**：某个动作选到了它处理不了的目标（例如伤害打卡牌、给玩家上卡牌状态）；
- **引用或事件参数缺失**：被动里引用了一个当前时机并不提供的参数（每个时机词带的参数不一样）。

处理办法：回摆盘，把可疑的那张卡 / 那条效果先禁用或简化（比如先删掉 `condition`），再跑一次；确认是哪一条之后再逐项核对参数名。仍然定位不到，就把 YAML 贴给作者（见下一节）。

## 7. 请别人帮忙时准备什么

1. 界面里的**问题行**（级别 + 错误码 + 文件:行 + 说明），有几条贴几条；
2. 出错的那个 YAML 文件（或相关那几行）；
3. 你期望的效果（"应该给友方加攻击"），以及实际看到的现象；
4. 顶栏那行统计（`卡包 N 个 · 卡牌 N 张 · 技能 N 个 · 问题 N 条`）。

有这四样，基本一轮就能定位。
