# 卡包模板（`cards/`）

一个卡包 = 一个目录，**目录名就是卡包 `id`**。把 `my_pack/` 整个复制出去、改名，再改内容。

    my_pack/
    ├── pack.yml              ← 包定义（id / owner / cards 清单）
    ├── cards/<卡牌id>.yml    ← 每张卡一个文件，文件名 = 卡牌 id
    └── images/               ← 卡图 / 卡框（png，文件名 = 卡牌 id）
        ├── cards/
        └── skills/

要点：

- **归属（`owner`）只在 `pack.yml` 里写一次**，包内卡牌**强制跟随**；卡牌文件里**不要**写 `owner`。
- 一包一归属，三态：`<hero_id>` = 归属某角色 / `common` = 普通包（普通池，所有角色可用）/ 省略 = 未定义卡包。
- `cards:` 清单里列出的每个 id，都要有 `cards/<id>.yml` 和 `images/cards/<id>.png`。
- 卡包**不装技能**（`skills:` 字段自 v0.11 起作废），技能走 `../skills/`（正式目录为 `skill_packs/`）。

字段定义见《YAML数据格式规范.md》§5（`docs/` 内，暂不入库）；完整样例见 `docs/YAML模板/包样例.yml`。
