# `templates/` —— 可复制即用的 YAML 模板

> 这一层是 `tutorial/` 的模板库：每个模板都是**能直接复制去改**的最小可用例子。
> 字段的**定义不在这里**（避免两处描述打架）——定义只在《YAML数据格式规范.md》里写一次，
> 讲解步骤见 `tutorial/` 下的教程章节（待写）。

## 三个目录（目录名由 RW 命名）

| 教程目录 | 对应的正式数据目录 | 里面是什么 |
|---|---|---|
| `cards/` | `packs/<pack_id>/` ⚠️ 顶层目录名待确认（见下） | 一个卡包 = 一个目录：`pack.yml` + `cards/<卡牌id>.yml` + `images/` |
| `skills/` | `skill_packs/<pack_id>/` ⚠️ 同上 | 一个技能包 = 一个目录：`pack.yml` + `skills/<技能id>.yml` + `images/` |
| `heroes/` | `heroes/<hero_id>/` | 一个角色 = 一个目录：`<角色id>.yml` + 头像 `<角色id>.png` + `images/` |

## 怎么用

把需要的目录**整个复制**出去，把 `my_pack` / `my_skill_pack` / `my_hero` 改成你自己的 id，再按注释改内容。
注意 **id 三处一致**：目录名 = 文件名 = 文件里的 `id`。

## ⚠️ 唯一还没定的一件事：正式数据目录的顶层名

模板这一层用的是 RW 命名的 **`cards/` · `skills/` · `heroes/`**；而 `docs/YAML数据格式规范.md` 里
正式的数据目录**目前仍写** `packs/<pack_id>/`（卡包）与 `skill_packs/<pack_id>/`（技能包）。
**是否把正式目录也统一成 `cards/<pack_id>/` 与 `skills/<pack_id>/`，等 RW 一句话**；在那之前
模板 README 里两套名字都会出现，以规范为准。

## 已定与待定

**已定（RW 拍板）**：

- 目录名用 **`heroes`**（不再用 `heros`）。
- 技能归属 = 技能自己的 **`heroes` 列表，必填、不可省略**：可以写多个英雄 id；**所有英雄可用写 `common`**；
  **所有英雄都不可用写 `sp`**（特殊情况下获得，如活动 / 掉落 / 彩蛋）。`common` / `sp` 是保留字、不是英雄 id。
- 卡牌 YAML 放包内 **`cards/` 子目录**（`<pack>/cards/<卡牌id>.yml`）。

**待定**：

- **光环（aura）字段** —— **已定案**（见 [docs/光环设计.md](../../docs/光环设计.md) v0.4），模板待补
  **同时**补进 `docs/YAML模板/` 与这里。
- 正式数据目录的顶层名（见上一节）。
