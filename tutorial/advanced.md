# 进阶：技能 · 附魔 · 光环 · 多重触发

本篇的例子大多取自开发版自带的**机制演示包**（安装版没有那个包）—— 但**下面的片段都贴全了，不用去找原卡**，直接抄进自己的卡即可。演示数值都是占位，目的只是"每种机制演示一次"。
读之前请先会做卡（[cards.md](cards.md)）。下面每段都是**节选**，抄进自己的卡时注意缩进要对上。

## 1. 技能

技能和卡住在同一个包里：文件放 `skills/<id>.yml`，并在 `pack.yml` 的 `skills:` 清单里列出来。和卡的区别：

- **没有 `cooldown`、不进行动条**：只有两种活法 —— 挂触发器（`trigger`），或者纯光环（`aura`）；
- **`heroes` 必填**：写 `common`（所有角色可用）、`sp`（特殊获得）或角色 id 列表；
- **`rarity` 必填**：与卡牌同一张品阶表，只影响表现层，不参与战斗计算；
- 同一触发帧内，**同一条技能至多结算一次**。

「战鼓」：任意卡牌行动后，若敌方还有卡，就给全体友方卡 +4 攻击。

```yaml
id: warDrums
name: 战鼓
version: 1
rarity: diamond
priority: 4
heroes: [common]
stats:
  atk: 4
trigger: { event: after_action }
condition:
  cmp: gt
  left: { count: all_enemy_cards }
  right: 0
actions:
  - do: gain_stat
    stat: atk
    amount: { ref: self.atk }
    stackLimit: 5
    target: all_own_cards
```

- `trigger` 里写**时机词**（清单见第 10 节）；`after_action` = 任意卡牌主动行动完成之后。
- `priority` 1–10，数值大者先结算（与卡牌被动同台比较）。
- **不写 `trigger`、也不写 `aura`** ⇒ 这条技能整局不结算，开局会播一条 `note`。

## 2. 纯光环技能

不写 `trigger`、只写 `aura` 的技能，等于"携带期间一直生效"的一个领域效果：

```yaml
id: frostAura
name: 凝霜领域
version: 1
rarity: silver
heroes: [common]
aura:
  select: all_enemy_cards
  mul:
    - { stat: atk, factor: 0.90 }
```

`own` / `enemy` 以**技能持有方**的视角解释；`mul` 只作用于卡牌读数，**玩家侧禁止倍率**。

## 3. 一条满条打多轮：`multicast`

```yaml
# 机制演示卡 emberPriest（节选：只留 DOT 那段，伤害段省略）
multicast: 2              # 行动条满一次，整组主动效果连打 2 遍
stats:
  atk: 25
  burn: 3                 # 灼烧层数
  poison: 4               # 剧毒层数
abilities:
  - id: 1
    kind: active
    actions:
      - do: gain_stat
        stat: burn
        amount: { ref: self.burn }
        target: enemy_player
```

注意：引擎对"同一条效果"有**每 20cs 一条**的节流，打不完的会顺延 —— `multicast` 不是瞬间爆发，而是"接着排"。

## 4. 每 N 次行动才结算：`everyN`

```yaml
- id: 2
  kind: active
  everyN: 3                  # 只在第 3、6、9… 次主动行动时结算
  actions:
    - do: shield
      target: own_player
      amount: { mul: [{ ref: self.shield }, 1.5] }
```

`everyN` **只属于主动条目**（≥2）；整张卡的 `cooldown` 不变，只是这一条效果不每次都跑。

## 5. 条件：什么时候才结算

`condition` 只给**被动 / 技能**用（主动条目没有条件）。可以是单个比较，也可以用 `all` / `any` / `not` 组合：

```yaml
# ironWall 的被动：血量在 20%～60% 之间才治疗
condition:
  all:
    - { cmp: lt, left: { ref: own_player.hp_pct }, right: 0.6 }
    - not: { cmp: lt, left: { ref: own_player.hp_pct }, right: 0.2 }
```

- 比较符：`lt` / `lte` / `gt` / `gte` / `eq` / `neq`；
- 两边都可以是表达式：`{ ref: own_player.hp }`、`{ var: player }`（事件参数）、`{ count: all_enemy_cards }`、数字；
- `own_player.hp_pct` 是"当前血量 ÷ 上限"（0～1 的小数）。

## 6. 卡牌状态 vs 玩家持续效果（两套，别混）

- **卡牌状态**：`apply_status` + `status: haste / slow / freeze` + `seconds`（秒）→ 加速 ×2 / 减速 ÷2 / 冰冻 = 0 且不能行动。⚠️ 时长字段是 `seconds`，**不是** `duration`（后者只属玩家持续效果通道）。
- **玩家持续效果**：`gain_stat` + `stat: burn / poison / regen`，目标是**玩家** → 层数叠加，灼烧 / 剧毒按秒跳伤、再生按秒回血。

```yaml
# 卡牌状态（照 frostBinder / ashRunner）
- do: apply_status
  target: all_enemy_cards
  status: freeze
  seconds: { ref: self.freeze }      # stats.freeze 存的是**秒数**
```

- 同类状态**再次施加 = 剩余时长叠加**（不覆盖、也不改周期）。
- 持续效果的层数会叠加，跳伤按引擎固定节奏走。
- ⚠️ 持续效果的 `duration` / `enter` / `exit` **当前不生效**，别写。

## 7. 附魔

附魔是"卡牌身上可以换的一件装备"：卡面只声明**目录**，局内用 `do: enchant` 把其中一件挂上去。

```yaml
# 目录：这张卡有哪几件附魔可选（卡面字段，合法）
enchantments:
  - id: aegis
    name: 壁垒
    color: '#74c0fc'
    stats:
      heal: 2                      # 生效期间并入本卡 stats
    actions:
      - do: heal_player
        target: own_player
        amount: { ref: self.heal }
```

施加方式：在动作里写 `{ do: enchant, target: self, enchant: aegis }`（或把 `target` 换成别的卡牌选择器）。

四条口径：

1. **卡面不能写 `enchant:`**（写"当前生效哪件"直接报错）—— 那是运行期状态；
2. 目标卡目录里**没有**这个 id ⇒ 这次动作**静默跳过**（不报错）；
3. 生效期间：`stats` 并入卡面读数、`actions` 追在本卡**每次主动行动末尾**结算、`aura` 持续生效；换附魔 = **整件替换**（旧效果全部回滚，单槽）；
4. 附魔 `actions` 要等"这张卡行动"才跑 ⇒ **`cooldown: -1` 的纯被动 / 纯光环卡挂了附魔也不会跑 actions**。

另外，摆盘界面的「编辑栏」也能直接指定附魔（导出的阵容 YAML 里对应 `cards[].enchant`）；那种写法里 id 写错是 **error**（与上面第 2 条的运行期容错不同）。

## 8. 光环

```yaml
# 只给友方加攻、没有倍率（照 frostBinder，合法形态）
aura:
  select: all_own_cards
  apply:
    - { stat: atk, amount: 2 }
```

- **作用域**：只改卡牌 `stats` 的**最终读数**；`speed` / `cdp` 不参与。
- **公式**：`(卡面 + 局内 buff + 所有平铺) × (1 + Σ(倍率 − 1))`，最后取整一次；两个 ×2 等于 ×3。
- **禁止**：`apply` 写 `speed` / `haste` / `slow` / `freeze`；`mul` 再禁 `cdp`；**玩家侧不能有 `mul`**，只接受 `burn` / `poison` / `regen` 的数值 `apply`。
- 数值位可写字面量；`apply.amount` 还接受表达式（如 `{ ref: self.atk }`），`mul.factor` **只能写字面量、两位小数**。
- 每 0.2 秒求值一次；来源离场，下一个触发帧就失效。

## 9. 九个动作原语

- **只作用于玩家**：`deal_damage`（伤害）· `heal_player`（治疗）· `shield`（护盾）
- **只作用于卡牌**：`apply_status`（加速 / 减速 / 冰冻）· `charge`（推进目标行动条）· `destroy`（失效）· `repair`（修复）· `enchant`（附魔）
- **两边都行**：`gain_stat`（属性增减；玩家侧 DOT 也走它）

目标类型不匹配（比如 `deal_damage` 选到卡牌）会在校验期报错；绕过校验会在对局里抛错中止。

## 10. 时机词

**引擎当前真的会广播的 15 个**：

```text
battle_start · after_action · on_player_damaged
on_player_healed · on_shield_gained · on_shield_broken
on_card_destroyed · on_card_repaired · on_card_charged
on_card_frozen · on_card_hasted · on_card_slowed
on_burn_tick · on_poison_tick · on_regen_tick
```

**还没接广播点的 2 个**：`before_action`、`battle_end` —— 写进 `trigger` 只报一条 `warn`，**整局不会结算**。想引用"谁受伤 / 伤害多少"，用事件参数 `{ var: player }` / `{ var: amount }`（每个时机词带哪些参数不一样，写错了校验期会提示）。

## 11. 调试建议

改完先点「**重载卡牌**」，把顶栏「问题 N 条」里的 `[error]` 清完再看效果；一次只加一条效果，不对劲就先把 `condition` 删掉，确认到底触发没触发；用长冷却 + 小数值更容易在回放里看清一条效果做了什么。
报错查 **[troubleshooting.md](troubleshooting.md)**，包结构查 **[packs.md](packs.md)**。
