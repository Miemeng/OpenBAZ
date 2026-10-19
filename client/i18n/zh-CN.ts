// 界面文案表（zh-CN）—— **目前只有中文**（《审阅.md》§AG.10 = A：先落结构、不加切换器）。
//
// 用途：`client/` 里所有"玩家可见"的固定文案都从这里取，组件里不写裸中文。
// 将来加 en 时，只需再建一份同形状的表 + 在 `index.ts` 里按语言选表。

/** 键名约定：`<区域>.<语义>`，全小写 + 点号分段 */
export const ZH_CN = {
  // —— 玩家面板 ——
  'panel.hp': '血量',
  'panel.maxHp': '上限',
  'panel.effective': '生效',
  'panel.deckFiles': '阵容文件',
  'panel.save': '保存',
  'panel.saveTitle': '保存本侧：导出 YAML（浏览器下载）并复制到剪贴板',
  'panel.noHero': '（未选角色）',
  'panel.heroDefault': '角色默认',
  'panel.emptyDeckList': '还没有阵容文件（decks/ 为空）',
  'panel.importDeckTitle': '导入到玩家{side}：{path}',
  'panel.currentDeckTitle': '当前来源：{path}',

  // —— 摆盘区 ——
  'board.deckFiles': '阵容文件',
  'board.deckFilesHint': 'A / B 两侧各有一份清单（见下方对应面板）；点一行导入到该侧，「保存」导出 YAML + 复制',
  'board.deckListError': '阵容列表取不到：{detail}',

  // —— 卡面 / 悬浮窗 ——
  'card.noStats': '没有可显示的数值',

  // —— 卡牌库 ——
  'library.search': '搜索卡名 / id / 卡包',
  'library.facetRarity': '品阶',
  'library.facetTags': '标签',
  'library.facetPacks': '卡包',
  'library.clearFilter': '清空筛选',
  'library.empty': '没有符合条件的卡牌',
  'library.emptyHint': '换一个关键词，或点「清空筛选」',
  'library.pickHint': '点左侧任意一张卡，看它的效果回显（与 CLI 的 sim:validate 同一套描述）',
  'library.count': '{visible} / {total} 张',
  'library.meta': '{rarity} · {size} · 版本 v{version} · 来源 {pack}',

  // —— 客户端外壳 ——
  'app.title': 'OpenBaz',
  'app.subtitle': '内部测试版 · 引擎 {version}',
  'app.tabLibrary': '卡牌库',
  'app.tabBoard': '摆盘',
  'app.reload': '重载卡牌',
  'app.reloading': '加载中…',
  'app.loadingHint': '正在加载卡牌数据…',
  'app.summary': '卡包 {packs} 个 · 卡牌 {cards} 张 · 技能 {skills} 个 · 问题 {issues} 条',
  'app.loadError': '取数失败：{detail}（检查 npm run dev 是否在跑、或 npm run packs:manifest 是否生成过清单）',
  'app.noCards': '还没有卡牌：桌面版默认从 {path} 读内容包。把带卡的包文件夹拷进去后点「重载卡牌」；开发期也可以用环境变量 OPENBAZ_DATA_DIR 指到仓库根再启动。',

  // —— 编辑栏 ——
  'edit.title': '编辑栏',
  'edit.noCard': '未选卡',
  'edit.pickHint': '点场上的一张卡来编辑它的附魔',
  'edit.pickSubHint': '附魔写在阵容里（局外养成），不改卡牌文件',
  'edit.enchantGroup': '附魔',
  'edit.noCatalog': '这张卡没有附魔目录（卡面未写 enchantments）',
  'edit.none': '— 无附魔 —',
  'edit.stats': '属性',
  'edit.statsHint': '· 留空 = 卡面值',

  // —— 结算面板 ——
  'result.seed': '种子',
  'result.seedHint': '（同一 seed 重跑逐字节一致）',
  'result.time': '用时',
  'result.artifacts': '产物',

  // —— 回放 ——
  'replay.title': '回放',
  'replay.back': '← 回到摆盘',
  'replay.frame': '帧',
  'replay.time': '时刻',
  'replay.logTitle': '本帧动作日志',
  'replay.emptyFrame': '这一帧没有结算（只有状态推进）',
  'replay.logCount': '触发帧 {frame} · {lines} 行',
  'replay.pinHint': '悬停看卡 · 单击钉住',
  'result.title': '结算',
  'replay.seed': '种子',
  'replay.seedSuffix': '帧（含开局快照）· 空格 播放 / 暂停 · ← → 逐帧（Shift ×10）· Home / End 首末帧',
  'replay.toStart': '回到开局',
  'replay.prev': '上一帧（←）',
  'replay.next': '下一帧（→）',
  'replay.play': '播放（空格）',
  'replay.pause': '暂停（空格）',
  'replay.btnPlay': '▶ 播放',
  'replay.btnPause': '⏸ 暂停',
  'replay.toEnd': '跳到末帧',
  'replay.seek': '拖动跳转',
  'replay.speedTitle': '{speed} 倍速（只影响播放间隔）',
  'replay.exit': '看终局读数与完整日志',
  'replay.exitShort': '查看结算',
  'replay.frameHint': '（触发帧 {frame} · 一帧 = {seconds}s）',

  // —— 卡面尺寸（卡牌库元信息用） ——
  'card.sizeSmall': '小',
  'card.sizeMedium': '中',
  'card.sizeLarge': '大',

  // —— 结算读数 ——
  'result.playerLine': '血量 {hp} / {maxHp} · 护盾 {shield}',
  'result.logCount': '日志 {lines} 行 · 提示消息 {messages} 条 · 帧快照 {frames} 帧',
  'result.noFrames': '（本局没有可回放的帧）',
  'result.replayHint': '（上方「回放这一局」按帧放）',
  'result.collapse': '收起结果',

  // —— 技能浮层 ——
  'panel.skillPicker': '选技能（可多选，点已选技能移除）',
  'panel.noSkills': '没有已注册的技能',
  'panel.skillNoDesc': '（这条技能没写 description）',
} as const

/** 界面文案的键类型（`t()` 只接受表里有的键） */
export type UiKey = keyof typeof ZH_CN
