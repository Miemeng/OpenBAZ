# 模板目录说明（`tutorial/templates/`）

> 本文件只讲**目录结构**与**怎么复制**，不讲玩法与字段细则。
> 字段的完整定义以为准（该文档在仓库的 `docs/` 内、**暂不入库**，外部读者看不到；对外以本目录的模板注释为准**docs 与 tutorial 的分层怎么划，待 RW 统一定**，见 `` / ``）。
> **命名口径**：**字段名与 id 都是驼峰**（`hiddenTags` / `engineRange` / `stackLimit` / `myPack` / `myCard` / `myHero` / `mySkill`）；而**封闭词表的值仍一律小写下划线**（`deal_damage` / `on_player_damaged` / `enemy_player` / `all_own_cards` …）。文件内 `id` 必须与**文件名（角色还要加目录名）**逐字一致。
> **说明**：目录结构已按 RW 重塑完毕（驼峰 id + 字段名驼峰 + 技能并入卡包 + 角色资源改位）；第 1 节是当前实况，第 2 节是复制步骤，第 3 节是仍待定的项。

---

## 1. 目录结构

```text
tutorial/templates/
├── README.md                       ← 本文件
└── packs/
    └── myPack/                     ← 包目录：**目录名 = pack.yml 里的 id**
        ├── pack.yml                包定义：id / name / version / owner / engineRange
        │                            + **cards 清单 + skills 清单**（卡牌与技能写在同一份里）
        ├── cards/
        │   └── myCard.yml          卡牌（文件名 = 卡牌 id）
        ├── heroes/
        │   └── myHero/             角色目录（**目录名 = 文件名 = 文件内 id**）
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

1. 把 `packs/myPack/` 整个复制到**数据根** `packs/` 下，并把包目录名改成你的包 id；
2. 按上面三条把 `id` / 清单 / 文件名对齐（**改名时三处一起改**）；
3. 改完跑一次校验（在仓库根执行）：

   ```powershell
   node simulator/validate.ts --root packs --summary                     # 校验你自己的工作区数据根
   node simulator/validate.ts --root tutorial/templates/packs --summary  # 校验本模板本身
   ```

   输出里 `error` 必须为 0；`warn` / `note` 可以留着看。

## 3. 已知待定项（写在模板里，避免踩坑）

| 项 | 现状 |
|----|------|
| **技能已并入卡包（目录名 `skills/`）** | 技能写在**外层 `myPack/pack.yml` 的 `skills:` 清单**里，**不再单独一份技能包 `pack.yml`**；目录名与规范一致。 |
| **角色资源位置** | 头像 = `images/heroes/<hero_id>/avatar.png`（**文件名固定 `avatar.png`**）、立绘 = `images/heroes/<hero_id>/portraits/*.png` —— 已落。 |
| **角色字段** | 角色只有 7 个字段（`id` / `name` / `version` / `initHp` / `initMaxHp` / `levelupMaxHp` / `description`）—— `tags`、`ownedSkillPacks`、**`ownedPacks`** 均已删除。 |
| **技能图标** | **没有 `icon` 字段**，走文件名约定 `images/skills/<skill_id>.png`。 |
| **附魔 `enchant`** | 字段已登记但**实现搁置**：写进 YAML 会被校验直接拒绝，模板里只作注释参考。 |
| **时机词** | 词典共 17 词，但引擎**目前只广播 3 个**（`battle_start` / `after_action` / `on_player_damaged`）。写未广播的时机能过校验，但**整局不会结算** —— 详见卡牌模板末尾的时机词表。 |
| **`rarities.yml`** | 只在需要自定义品阶时放包根；只用内置 `bronze / silver / gold / diamond` 的包不用写。 |
| **卡牌价值** | **就是 `stats.value`**（卡面数值表里的一项）；缺省取本卡**当前品阶**的 `value`（品阶表项）。★ 旧的 `buyPrize` / `prize` **已废除**。品阶与价值的默认表 = [packs/base/rarities.yml](../packs/base/rarities.yml)。 |
| **字段名** | **字段名与 id 都已改驼峰**—— 见文件头"命名口径"。 |
