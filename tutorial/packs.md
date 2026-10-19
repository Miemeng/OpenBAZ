# 做一个卡包

**包（`pack`，也叫内容包）** 是数据目录下的一个文件夹，装卡牌、技能、角色和图片。程序启动时会把 `packs` 下所有包读一遍，注册成一个卡池 —— 你新加的包不需要改任何程序。

> 只想做卡的话，先看 [cards.md](cards.md)（那一篇已经把"新建包"走过一遍）；本篇讲包本身的规矩。

## 1. 文件夹结构

```text
%APPDATA%\OpenBaz\packs\
└── myPack/                  ← 文件夹名 = pack.yml 里的 id
    ├── pack.yml             包定义（必填）
    ├── rarities.yml         品阶表（选填：要自定义品阶时才放）
    ├── cards/
    │   └── mySword.yml      卡牌：文件名 = 卡内 id
    ├── skills/
    │   └── mySkill.yml      技能：文件名 = 技能内 id
    ├── heroes/
    │   └── myHero/          角色：文件夹名 = 文件名 = 角色 id
    │       └── myHero.yml
    └── images/
        ├── cards/           卡图：<card_id>.png
        ├── skills/          技能图标：<skill_id>.png
        ├── frames/          卡框：<frame_id>/card_frame.png + skill_frame.png
        └── heroes/
            └── myHero/
                ├── avatar.png      头像（文件名固定）
                └── portraits/      立绘（选填，任意 png）
```

**三条硬对应关系**（最容易写错的地方）：

1. **包文件夹名 = `pack.yml` 的 `id`** —— 不一致 ⇒ 整个包不加载；
2. **卡牌 / 技能的文件名 = 文件内的 `id`**；
3. **角色的文件夹名 = 文件名 = 文件内 `id`**（`heroes/myHero/myHero.yml`）。

## 2. `pack.yml` 逐字段

```yaml
id: myPack                 # 必填：必须等于文件夹名
name: 我的卡包              # 必填：显示名
version: 1                 # 必填：≥1，包整体版本
description: 练手用的包      # 选填：包选择界面小字
builtin: false             # 选填：缺省 false（玩家包）；内置包才写 true
owner: common              # 选填：common = 普通池，或写某个角色 id

engineRange:               # 必填：兼容的引擎版本区间列表（至少 1 项）
  - from: '0.1.0'          #   缺省左闭右开；省略一侧 = 无界

rarities:
  source: builtin          # 选填：builtin = 用内置四档；file = 用包根 rarities.yml

cards:                     # 卡牌清单：裸文件名（不带 .yml），每条 = cards/<id>.yml = 卡内 id
  - mySword
skills:                    # 技能清单：同样写裸文件名
  - mySkill
```

| 字段 | 要点 |
|---|---|
| `id` | 首字符字母，其余字母 / 数字 / 下划线；**与文件夹名逐字一致** |
| `engineRange` | 版本号**写全三段 `major.minor.patch` 并加引号**（`'0.1.0'`；不加引号会被读成数字）。区间不命中当前引擎版本 ⇒ **error，整包不注册** |
| `owner` | 卡牌的默认归属：`common`（普通池）或某个角色 id；**卡牌自己写了 `owner` 就以卡牌为准**（与包不一致只报 `note`） |
| `cards` / `skills` | **至少写一项**（纯品阶包例外，见下）。另有选填的 `author` / `license` / `homepage` / `checksum` / `createdAt` / `updatedAt` / `assets` / `dependencies`，程序不读，供分发识别用 |

> `builtin: true` 只给随程序分发的内置包（`base` 等）。玩家包别写，它只是"这是内置内容"的标记。

## 3. 清单是权威

- **没列进 `cards:` / `skills:` 的文件不会被加载**，只记一条 `note`；
- **列了但文件不存在** ⇒ **error**（这个包里的那一条注册失败）；
- 清单元素写成 `mySword.yml` 或 `cards/mySword` ⇒ **error**（只写裸 id）；
- 改名时**文件名、文件内 `id`、清单**三处一起改。

角色不在清单里：程序直接扫 `heroes/<id>/<id>.yml`。

## 4. 品阶与卡牌价值

- **内置四档**：`bronze` / `silver` / `gold` / `diamond`，默认价值 **1 / 2 / 4 / 8**。不写 `rarities` 就用它们。
- **卡牌价值** = 卡面 `stats.value`；没写 ⇒ 取本卡当前品阶的 `value`。
- **自定义品阶**：在包根放 `rarities.yml` 并把 `rarities.source` 改成 `file`：

```yaml
rarities:
  - id: bronze
    name: 青铜
    color: '#8d6e63'
    value: 1
  - id: mythic
    name: 神话
    color: '#ff6b6b'
    frame: mythic          # 卡框素材：images/frames/mythic/card_frame.png
    value: 16
```

- `upgrade`（选填）= 二合一合成链：每一项都必须是本文件里**已登记**的品阶，且**只允许内置四档**；自定义品阶能登记、能被卡牌引用，但**不能进链**。
- 改成 `file` 之后，**内置四档不会自动合并** —— 你的卡用到的品阶都要在这个文件里写出来。
- 只放品阶表、没有卡和技能的**纯规则包**也是合法包，但必须显式写 `rarities: { source: file }`。

## 5. 角色

没有角色客户端开不了局。角色只有 7 个字段：

```yaml
id: myHero
name: 我的角色
version: 1
initHp: 300                # 初始血量（必填）
initMaxHp: 300             # 血量上限；缺省 = initHp
levelupMaxHp: [100, 200, 300, 400]   # 升级时提升的上限（升级机制尚未启用，占位）
description: 示例角色
```

- `initMaxHp` 比 `initHp` 小 ⇒ error。
- 头像放 `images/heroes/<hero_id>/avatar.png`（文件名固定）；缺图不报错，界面回落成首字色块。
- **角色要跟"有内容的包"一起走**：`pack.yml` 必须至少有一张卡或一个技能。只做角色、不做卡是不合法的；临时测试可以直接用内置的**盗贼 / 守卫**。

## 6. 图片与命名

| 素材 | 路径 | 缺图时 |
|---|---|---|
| 卡图 | `images/cards/<card_id>.png` | 回落成品阶色块 / 首字 |
| 技能图标 | `images/skills/<skill_id>.png` | 同上 |
| 角色头像 | `images/heroes/<hero_id>/avatar.png` | 首字色块 |
| 角色立绘 | `images/heroes/<hero_id>/portraits/*.png` | 不显示 |
| 卡框 | `images/frames/<frame_id>/card_frame.png` | 用该品阶的 `color` 纯色 |
| 技能框 | `images/frames/<frame_id>/skill_frame.png` | 同上 |

- **卡框由品阶决定**，卡面没有 `frame` 字段（写了会报错）。
- 图片缺失**只影响观感**，不阻塞加载。

## 7. 包放哪儿、怎么生效

所有包都放在**数据目录**里：

```text
%APPDATA%\OpenBaz\packs\<你的包文件夹>\
```

按 **Win + R** 粘贴 `%APPDATA%\OpenBaz\packs` 回车就能打开它（第一次启动程序后才会存在）。

放好后回界面点右上角「**重载卡牌**」。每次启动程序也会自动读一遍。

> 别直接改内置包（`base` 等）：它们随程序更新，改了容易丢。要改就复制成自己的包再改。

## 8. 一个最小可用的包

只要两个文件（用内置角色就能开局）：

```yaml
# myPack/pack.yml
id: myPack
name: 我的卡包
version: 1
engineRange: [{ from: '0.1.0' }]
cards:
  - oneBlade
```

```yaml
# myPack/cards/oneBlade.yml
id: oneBlade
name: 一把刀
version: 1
size: small
cooldown: 3.00
rarity: bronze
stats:
  atk: 6
abilities:
  - id: 1
    kind: active
    actions:
      - do: deal_damage
        target: enemy_player
        amount: { ref: self.atk }
```

## 9. 校验与分享

**校验**：回界面点「**重载卡牌**」，看顶栏「**问题 N 条**」与下面的清单。

```text
[error] card.ref.undefined_stat  myPack/cards/oneBlade.yml  引用未定义的属性：self.atk
```

行首 `[error]` / `[warn]` / `[note]` 是级别，跟着是错误码、文件（带行号）、说明。**只有 `[error]` 会让那一条加载失败**；`[warn]` / `[note]` 不影响加载。对照表见 **[troubleshooting.md](troubleshooting.md)**。

**分享**：把整个包文件夹压缩发给别人，对方解压到自己的 `%APPDATA%\OpenBaz\packs` 下即可。建议顺手写 `author` / `license`，每次更新把 `version` +1。

## 10. 下一步

- 技能、附魔、光环、多重触发、条件表达式 → **[advanced.md](advanced.md)**（结构骨架见 **[templates/](templates/)**）
- 报错对照表 → **[troubleshooting.md](troubleshooting.md)**
