# 模板目录说明（`tutorial/templates/`）

> 本文件只讲**目录结构**与**怎么复制**，不讲玩法与字段细则。
> 字段的完整定义见《YAML 数据格式规范》；本目录里的模板注释也把每个字段的用法写清了，照着改即可。
> **命名口径**：**字段名与 id 都是驼峰**（`hiddenTags` / `engineRange` / `stackLimit` / `myPack` / `myCard` / `myHero` / `mySkill`）；而**封闭词表的值仍一律小写下划线**（`deal_damage` / `on_player_damaged` / `enemy_player` / `all_own_cards` …）。文件内 `id` 必须与**文件名（角色还要加目录名）**逐字一致。
> **说明**：目录结构已按当前规范落好（驼峰 id + 字段名驼峰 + 技能并入卡包 + 角色资源单独放）；第 1 节是当前实况，第 2 节是复制步骤，第 3 节是几个容易踩的约定。

---

## 1. 目录结构

```text
tutorial/templates/
├── README.md                       ← 本文件
└── packs/
    └── myPack/                     ← 包目录：目录名 = pack.yml 里的 id
        ├── pack.yml                包定义：id / name / version / owner / engineRange
        │                            + **cards 清单 + skills 清单**（卡牌与技能写在同一份里）
        ├── cards/
        │   └── myCard.yml          卡牌（文件名 = 卡牌 id）
        ├── heroes/
        │   └── myHero/             角色目录（目录名 = 文件名 = 文件内 id）
        │       └── myHero.yml      角色定义
        ├── skills/                 技能
        │   └── mySkill.yml         技能（文件名 = 技能 id）
        └── images/
            ├── cards/              卡图：<card_id>.png
            ├── skills/             技能图标：<skill_id>.png
            └── heroes/
                └── myHero/
                    ├── avatar.png          头像（**必填**，文件名固定 avatar.png）
                    └── portraits/         立绘（**选填**，里面放任意 png）
```

**三处容易写错的地方**：

1. **`pack.yml` 的 `id` 必须等于包目录名**（这里是 `myPack`）—— 不一致 = 整包不加载；
2. **`cards:` / `skills:` 是裸文件名清单**（不带 `.yml`）**清单是权威**：没列出的文件不加载（只记一条 `note`），列了但文件不存在则报 `error`；
3. **角色是"目录 + 同名文件"**（`heroes/myHero/myHero.yml`），不像卡牌 / 技能那样直接平铺在 `cards/` / `skills/` 下；**角色资源另放 `images/heroes/<hero_id>/`**（头像 `avatar.png` + 立绘 `portraits/`）。

## 2. 怎么用

1. 按 **Win + R** 粘贴 `%APPDATA%\OpenBaz\packs` 回车，打开数据目录；
2. 把本目录的 `packs/myPack/` 整个复制进去，并把文件夹名改成你的包 id；
3. 按上面三条把 `id` / 清单 / 文件名对齐（**改名时三处一起改**）；
4. 回界面点「**重载卡牌**」，看顶栏「**问题 N 条**」—— 显示 0 就说明这份骨架在你机器上是干净的；有问题按 [troubleshooting.md](../troubleshooting.md) 查。

## 3. 几个容易踩的约定

| 项 | 现状 |
|----|------|
| **技能已并入卡包（目录名 `skills/`）** | 技能写在**外层 `myPack/pack.yml` 的 `skills:` 清单**里，**不再单独一份技能包 `pack.yml`**；目录名与规范一致。 |
| **角色资源位置** | 头像 = `images/heroes/<hero_id>/avatar.png`（**文件名固定 `avatar.png`**）、立绘 = `images/heroes/<hero_id>/portraits/*.png` —— 已落。 |
| **角色字段** | 角色只有 7 个字段（`id` / `name` / `version` / `initHp` / `initMaxHp` / `levelupMaxHp` / `description`）—— `tags`、`ownedSkillPacks`、**`ownedPacks`** 均已删除。 |
| **技能图标** | **没有 `icon` 字段**，走文件名约定 `images/skills/<skill_id>.png`。 |
| **附魔 `enchant`** | 卡面**不写** `enchant`（"当前生效哪一件"是运行期状态，写进 YAML 会被校验拒绝）；**附魔目录 `enchantments` 是合法卡面字段**，由局内 `do: enchant` 施加（写法见 [advanced.md](../advanced.md)）。 |
| **时机词** | 词典共 17 词，引擎**已广播 15 个**；**未广播的只有 `before_action` / `battle_end`**（写了能过校验，但整局不会结算）—— 完整清单见卡牌模板末尾的时机词表。 |
| **`rarities.yml`** | 只在需要自定义品阶时放包根；只用内置 `bronze / silver / gold / diamond` 的包不用写。 |
| **卡牌价值** | **就是 `stats.value`**（卡面数值表里的一项）；缺省取本卡**当前品阶**的 `value`（品阶表项）。★ 卡面上的旧字段 `buyPrize` / `prize` **已废除**。品阶与价值的默认表在基础包 `base` 的 `rarities.yml`。 |
| **字段名** | **字段名与 id 都已改驼峰**—— 见文件头"命名口径"。 |
