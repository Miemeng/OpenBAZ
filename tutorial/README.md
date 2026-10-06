# tutorial/ —— 对外教程与 YAML 模板

> 状态：**目录已建立；`templates/` 已落盘（v0.32），教程正文待填**。
> 语言约定：**目录名与文件名用英文，正文用中文**（RW 指示；将来要出英文版另开 `tutorial/en/`，不要把现有正文改成英文）。
> 本目录**入库**；`docs/`（内部设计文档）**暂时不入库**，见仓库根 `.gitignore`。

---

## 1. 这里放什么

1. **教程**：面向玩家与 DIY 作者的操作性文档 —— 怎么做一张卡、怎么做一个卡包、怎么自定义角色、怎么摆盘与模拟。
2. **YAML 模板**：可以直接复制去改的模板文件（卡牌 / 技能 / 卡包 / 角色 / 品阶 / 阵容）。

## 2. 与 `docs/` 的分工

| 目录 | 读者 | 回答的问题 | 是否入库 |
|------|------|------------|----------|
| `tutorial/` | 玩家、DIY 作者（外部） | **怎么做**（教程 + 可复制模板） | ✅ 入库 |
| `docs/` | 开发者、策划（内部） | **为什么这么做**（规则书 / 框架 / 规范 / 待办） | ⛔ 暂时不入库 |

**同一个字段只在一处定义**：`docs/YAML数据格式规范.md` 是唯一格式标准；`tutorial/` 里的模板是它的**对外投影**。冲突时以规范为准 —— 教程只讲"怎么填"，不重新定义规则。

## 3. 计划的目录结构（草案，随内容落地调整）

```
tutorial/
├── README.md            # 本文件
├── 01-first-card.md     # 第一张卡：从 YAML 到生效（待写）
├── 02-pack.md           # 做一个卡包（目录结构 / pack.yml / 打包 zip）（待写）
├── 03-hero.md           # 自定义角色（heroes/<hero_id>/<hero_id>.yml + 头像 + images/ 立绘）（待写）
├── 04-deck.md           # 摆盘与阵容（待写）
├── 05-skills.md         # 技能与光环（待写）
└── templates/           # 可复制即用的模板（v0.32 已建；目录名按 RW 的命名改为 cards / skills / heroes）
    ├── README.md
    ├── cards/my_pack/             # pack.yml + cards/my_card.yml + images/{cards,skills}/
    ├── skills/my_skill_pack/      # pack.yml + skills/my_skill.yml + images/
    └── heroes/my_hero/            # my_hero.yml + images/
```

> `templates/` 里是**简版**模板（能直接复制去改）；完整字段与全部可选项见 `docs/YAML模板/`。
> 两份的待定项都标了 ⚠️；光环（aura）字段**已定案**（见 `docs/光环设计.md` v0.4），两边的模板**待补**。

## 4. 待办（内容还没写）

- [x] `tutorial/templates/` 下的模板（**v0.32 已建**；目录名按 RW 的命名 = **`cards/` · `skills/` · `heroes/`**，各含可复制即用的简版 YAML + 简短 README）。**尚待补**：**光环 `aura` 字段**（**已定案**，见 `docs/光环设计.md` v0.4，两边同时补）、**顶层数据目录名**（正式路径仍写 `packs/` 与 `skill_packs/`，见模板 README）。**已定**：目录名用 `heroes`；技能 `heroes` 必填 + `common` / `sp`；卡牌放 `cards/` 子目录。
- [ ] 等 `docs/YAML模板/` 定稿后做一次**对齐复查**（模板是简版，字段以规范为准；**光环字段要两边同时补**）。
- [ ] 教程正文等"最小可跑版验收通过 → 玩法定型"之后再写，否则写完就要重写。
- [ ] 文件名一律英文（`01-first-card.md`），正文中文。
- [ ] `docs/` 恢复入库时要同步改本文件第 2 节的"是否入库"列（`.gitignore` 里那行 `docs/`）。
