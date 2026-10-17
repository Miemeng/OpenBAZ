/**
 * **宿主适配层**：目录遍历 + 读文件。
 *
 * 这是 `cards/` 下**唯一允许引用 `node:*`** 的文件（`eslint.config.js` 的纯逻辑白名单不含
 * `cards/loader*`）。它自己不做校验：解析与校验全部交给纯逻辑层（`cards/schema.ts`），
 * 成功的结果映射成引擎契约（`cards/map.ts`），最后交给调用方决定注册（`cards/registry.ts`）。
 *
 * 口径：
 *  - **只产出不抛错**：一切失败都进 `LoadResult.errors`；`severity = 'error'` 的条目会阻断
 *    该文件（或该整包）的注册，`warn` / `note` 只报告；
 *  - **一次加载 = 一次完整遍历**，函数无内部状态，可重复调用；重载 = 再调一次 + `replaceAll()`；
 *  - **粒度**：单个卡牌 / 技能文件坏 ⇒ 只有它不注册；`pack.yml` 坏 / 缺失 / 目录名与 id 不符
 *    / `rarities.yml` 坏 ⇒ **整包不注册**；
 *  - **同 id 冲突**（`pack.duplicate_id`）保留**先到者**，先到次序 = 卡包目录名的字典序；
 *  - `drafts/` 与 `card_values.yml` 本轮不参与加载。
 *
 * 路径口径：`file` 字段用的是**按传入 `root` 拼出来的路径**（传入相对路径 `packs` 时
 * 错误里就是 `packs/myPack/pack.yml`）；不额外做 cwd 归一化。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mapCard, mapHero, mapRarity, mapSkill } from './map.ts'
import { BUILTIN_RARITY_IDS, BUILTIN_UPGRADE_CHAIN } from './economy.ts'
import {
  heroDtoSchema,
  issuesToErrors,
  packManifestDtoSchema,
  parseYamlDocument,
  problem,
  raritiesFileDtoSchema,
  skillDtoSchema,
  cardDtoSchema,
  validateCard,
  validateHero,
  validatePackManifest,
  validateRaritiesFile,
  validateSkill,
} from './schema.ts'
import type { PackManifestDto, ValidationContext } from './schema.ts'
import { LOAD_ERROR_CODES } from './types.ts'
import type {
  CardDef,
  HeroDef,
  LoadedPack,
  LoadedRarities,
  LoadResult,
  SkillDef,
  ValidationError,
} from './types.ts'
import type { SourcePosition } from './yaml-positions.ts'

/** 仓库内的默认数据根（单一数据根 = `packs/`）。 */
export const PACKS_ROOT = 'packs'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** 跨包共享的加载期状态（同 id 先到者保留、技能 `heroes` 引用校验）。 */
interface LoadScope {
  /** 全部已发现英雄 id（预扫描目录名，让技能包能引用别的包里的英雄）。 */
  readonly heroIds: ReadonlySet<string>
  readonly cardIds: Set<string>
  readonly skillIds: Set<string>
}

interface PackLoadOutcome {
  readonly pack?: LoadedPack
  readonly errors: readonly ValidationError[]
}

// ————————————————————————————————————————————————————————
// 文件系统小工具（都吞掉异常：宿主层的失败一律转成错误条目）
// ————————————————————————————————————————————————————————

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 按 `.yml` → `.yaml` 顺序找第一个能读的文件。 */
function readFirst(pathBase: string): { readonly path: string; readonly text: string } | undefined {
  for (const extension of ['.yml', '.yaml']) {
    const path = `${pathBase}${extension}`
    const text = readText(path)
    if (text !== undefined) return { path, text }
  }
  return undefined
}

function listSubdirectories(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 目录下 `.yml` / `.yaml` 的**裸文件名**（去扩展名），字典序。 */
function listYamlNames(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name.replace(/\.ya?ml$/, ''))
      .sort()
  } catch {
    return []
  }
}

function fileContext(file: string): ValidationContext {
  return { file, positions: new Map<string, SourcePosition>() }
}

function isFatal(issue: ValidationError): boolean {
  return (issue.severity ?? 'error') === 'error'
}

/** 预扫描：收集所有卡包 `heroes/<hero_id>/` 的目录名作为已知英雄 id。 */
function collectHeroIds(root: string): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const packId of listSubdirectories(root)) {
    for (const heroId of listSubdirectories(join(root, packId, 'heroes'))) ids.add(heroId)
  }
  return ids
}

/**
 * 技能子目录名 = **规范口径 `skills/`**。
 *
 * 沿革： 模板目录一度拼成 `skilles/`，那时这里做了一层"两个名字都认"的兼容；
 * RW 已把目录改名（「我拼写错误了，改成 skills 就好」），** 回收该兼容**（ ``）。
 */
const SKILLS_DIR = 'skills'

// ————————————————————————————————————————————————————————
// 单个文件的加载
// ————————————————————————————————————————————————————————

/** 读文件 + YAML 解析；返回 `undefined` 表示已把错误写进 `errors`。 */
function parseFile(
  pathBase: string,
  missingMessage: string,
  errors: ValidationError[],
): { readonly path: string; readonly text: string } | undefined {
  const found = readFirst(pathBase)
  if (found === undefined) {
    errors.push(
      problem(LOAD_ERROR_CODES.packManifest, missingMessage, fileContext(pathBase), [], {
        suggestion: '：清单里点名的文件必须存在（`cards/` / `skills/` 下同名 `.yml`）',
      }),
    )
    return undefined
  }
  return found
}

function loadCardFile(
  pathBase: string,
  expectedId: string,
  packOwner: string | undefined,
  packId: string,
  registeredRarities: readonly string[],
  rarityChain: readonly string[],
  scope: LoadScope,
  errors: ValidationError[],
): CardDef | undefined {
  const found = parseFile(pathBase, `清单点名的卡牌文件不存在：${pathBase}.yml`, errors)
  if (found === undefined) return undefined

  const doc = parseYamlDocument(found.text, found.path)
  if (doc.syntaxError !== undefined) {
    errors.push(doc.syntaxError)
    return undefined
  }
  const ctx: ValidationContext = { file: found.path, positions: doc.positions }
  const parsed = cardDtoSchema.safeParse(doc.value)
  if (!parsed.success) {
    errors.push(...issuesToErrors(parsed.error.issues, ctx))
    return undefined
  }
  const semantic = validateCard(parsed.data, ctx, { fileName: expectedId, packId, registeredRarities, rarityChain, packOwner })
  errors.push(...semantic)
  if (semantic.some(isFatal)) return undefined

  if (scope.cardIds.has(parsed.data.id)) {
    errors.push(
      problem(
        LOAD_ERROR_CODES.packDuplicateId,
        `卡牌 id 已被先加载的卡包占用：${parsed.data.id}（本包 ${packId} 的这份不注册）`,
        ctx,
        ['id'],
        { suggestion: '：同 id 冲突保留先到者（目录名字典序）；请改 id 或改文件名' },
      ),
    )
    return undefined
  }
  scope.cardIds.add(parsed.data.id)

  return mapCard(parsed.data, packOwner === undefined ? {} : { packOwner })
}

function loadSkillFile(
  pathBase: string,
  expectedId: string,
  packId: string,
  registeredRarities: readonly string[],
  scope: LoadScope,
  errors: ValidationError[],
): SkillDef | undefined {
  const found = parseFile(pathBase, `清单点名的技能文件不存在：${pathBase}.yml`, errors)
  if (found === undefined) return undefined

  const doc = parseYamlDocument(found.text, found.path)
  if (doc.syntaxError !== undefined) {
    errors.push(doc.syntaxError)
    return undefined
  }
  const ctx: ValidationContext = { file: found.path, positions: doc.positions }
  const parsed = skillDtoSchema.safeParse(doc.value)
  if (!parsed.success) {
    errors.push(...issuesToErrors(parsed.error.issues, ctx))
    return undefined
  }
  const semantic = validateSkill(parsed.data, ctx, { fileName: expectedId, knownHeroIds: scope.heroIds, registeredRarities })
  errors.push(...semantic)
  if (semantic.some(isFatal)) return undefined

  if (scope.skillIds.has(parsed.data.id)) {
    errors.push(
      problem(
        LOAD_ERROR_CODES.packDuplicateId,
        `技能 id 已被先加载的技能包占用：${parsed.data.id}（本包 ${packId} 的这份不注册）`,
        ctx,
        ['id'],
        { suggestion: '：同 id 冲突保留先到者（目录名字典序）' },
      ),
    )
    return undefined
  }
  scope.skillIds.add(parsed.data.id)

  return mapSkill(parsed.data)
}

/**
 * 英雄文件（`heroes/<hero_id>/<hero_id>.yml`）。
 *
 * 本轮**英雄只落数据、不参与注册**（`CardRegistry` 只管卡牌与技能），所以这里的错误
 * 只报告、**不阻断整包**：即使某个英雄文件坏掉，该包的卡牌与技能照常加载。
 */
function loadHeroFiles(packDir: string, packId: string, errors: ValidationError[]): readonly HeroDef[] {
  const heroes: HeroDef[] = []
  for (const heroId of listSubdirectories(join(packDir, 'heroes'))) {
    const pathBase = join(packDir, 'heroes', heroId, heroId)
    const found = readFirst(pathBase)
    if (found === undefined) {
      errors.push(
        problem(
          LOAD_ERROR_CODES.packManifest,
          `英雄目录缺少同名定义文件：heroes/${heroId}/${heroId}.yml`,
          fileContext(`${pathBase}.yml`),
          [],
          { severity: 'warn', suggestion: '：路径为 packs/<pack_id>/heroes/<hero_id>/<hero_id>.yml' },
        ),
      )
      continue
    }
    const doc = parseYamlDocument(found.text, found.path)
    if (doc.syntaxError !== undefined) {
      errors.push(doc.syntaxError)
      continue
    }
    const ctx: ValidationContext = { file: found.path, positions: doc.positions }
    const parsed = heroDtoSchema.safeParse(doc.value)
    if (!parsed.success) {
      errors.push(...issuesToErrors(parsed.error.issues, ctx))
      continue
    }
    const semantic = validateHero(parsed.data, ctx)
    errors.push(...semantic)
    if (parsed.data.id !== heroId) {
      errors.push(
        problem(
          LOAD_ERROR_CODES.packManifest,
          `英雄 id「${parsed.data.id}」与目录名「${heroId}」不一致`,
          ctx,
          ['id'],
          { suggestion: `：目录名、文件名与 id 必须一致（本包 ${packId}）` },
        ),
      )
      continue
    }
    if (semantic.some(isFatal)) continue
    heroes.push(mapHero(parsed.data))
  }
  return heroes
}

/**
 * 品阶表（`rarities.yml`，仅当 `pack.yml` 写 `rarities: { source: file }` 时读）。
 * 返回值里的 `chain` = 该包的**品阶合成链**（从最低到最高），供卡牌 `inheritOverride` 分段校验；
 * 未写 `upgrade` 时按「内置四档 + 包内自定义品阶」拼链（ 把 `upgrade` 标为选填）。
 */
function loadRarities(
  packDir: string,
  errors: ValidationError[],
): { readonly value: LoadedRarities; readonly chain: readonly string[] } | undefined {
  const pathBase = join(packDir, 'rarities')
  const found = readFirst(pathBase)
  const file = `${pathBase}.yml`
  if (found === undefined) {
    errors.push(
      problem(LOAD_ERROR_CODES.packManifest, '声明了 rarities: { source: file } 但找不到 rarities.yml', fileContext(file), ['rarities'], {
        suggestion: '改写成 source: builtin（用引擎内置品阶表）或补上包内 rarities.yml',
      }),
    )
    return undefined
  }
  const doc = parseYamlDocument(found.text, found.path)
  if (doc.syntaxError !== undefined) {
    errors.push(doc.syntaxError)
    return undefined
  }
  const ctx: ValidationContext = { file: found.path, positions: doc.positions }
  const parsed = raritiesFileDtoSchema.safeParse(doc.value)
  if (!parsed.success) {
    errors.push(...issuesToErrors(parsed.error.issues, ctx))
    return undefined
  }
  const semantic = validateRaritiesFile(parsed.data, ctx)
  errors.push(...semantic)
  if (semantic.some(isFatal)) return undefined
  const items = parsed.data.rarities.map((rarity) => mapRarity(rarity))
  // （ ``）：**合成链暂时只允许内置四档**
  // 自定义品阶不再自动接在内置链之后（旧口径 `[...BUILTIN_UPGRADE_CHAIN, ...extras]` 作废），
  // 链上出现自定义品阶由 `validateRaritiesFile` 报 `error`。包内自定义品阶本身仍可登记（供 `rarity` 引用）。
  return {
    value: { source: 'file', items },
    chain: parsed.data.upgrade ?? BUILTIN_UPGRADE_CHAIN,
  }
}

// ————————————————————————————————————————————————————————
// 单个卡包
// ————————————————————————————————————————————————————————

function loadOnePack(packDir: string, packId: string, scope: LoadScope): PackLoadOutcome {
  const errors: ValidationError[] = []
  const manifestPath = join(packDir, 'pack.yml')
  const found = readFirst(join(packDir, 'pack'))
  if (found === undefined) {
    errors.push(
      problem(LOAD_ERROR_CODES.packManifest, '卡包目录缺少 pack.yml', fileContext(manifestPath), [], {
        suggestion: '：packs/<pack_id>/pack.yml 是卡包的入口清单（整包不注册）',
      }),
    )
    return { errors }
  }

  const doc = parseYamlDocument(found.text, found.path)
  if (doc.syntaxError !== undefined) return { errors: [doc.syntaxError] }
  const ctx: ValidationContext = { file: found.path, positions: doc.positions }

  const parsed = packManifestDtoSchema.safeParse(doc.value)
  if (!parsed.success) {
    // pack.yml 结构坏 ⇒ 整包不注册
    return { errors: issuesToErrors(parsed.error.issues, ctx) }
  }
  const dto: PackManifestDto = parsed.data

  const manifestIssues: ValidationError[] = [...validatePackManifest(dto, ctx)]
  if (dto.id !== packId) {
    manifestIssues.push(
      problem(LOAD_ERROR_CODES.packManifest, `pack.yml 的 id「${dto.id}」与目录名「${packId}」不一致`, ctx, ['id'], {
        suggestion: '：目录名即 pack_id',
      }),
    )
  }
  errors.push(...manifestIssues)
  if (manifestIssues.some(isFatal)) return { errors }

  let rarities: LoadedRarities | undefined
  // ⚠️ ：**"已登记"与"合成链"是两件事，必须分开传**。
  //    `rarities.yml` 里的**自定义品阶可以登记、也可以被卡牌 `rarity` 引用**，
  //    但**不得进入 `upgrade` 链**；链只用于 `inheritOverride` 的分段校验。
  let registeredRarities: readonly string[] = BUILTIN_RARITY_IDS
  let rarityChain: readonly string[] = BUILTIN_UPGRADE_CHAIN
  if (dto.rarities?.source === 'file') {
    const loaded = loadRarities(packDir, errors)
    if (loaded === undefined) return { errors }
    rarities = loaded.value
    rarityChain = loaded.chain
    registeredRarities =
      loaded.value.source === 'file' ? loaded.value.items.map((item) => item.id) : BUILTIN_RARITY_IDS
  } else if (dto.rarities !== undefined) {
    rarities = { source: 'builtin' }
  }

  // ——— 卡牌 —
  const listedCards = dto.cards ?? []
  const cards: CardDef[] = []
  for (const name of listedCards) {
    const card = loadCardFile(join(packDir, 'cards', name), name, dto.owner, packId, registeredRarities, rarityChain, scope, errors)
    if (card !== undefined) cards.push(card)
  }
  for (const name of listYamlNames(join(packDir, 'cards'))) {
    if (listedCards.includes(name)) continue
    errors.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `文件未在 pack.yml 的 cards 清单中列出，未注册：${name}.yml`,
        fileContext(join(packDir, 'cards', `${name}.yml`)),
        [],
        { severity: 'note', suggestion: '：目录里有而清单未列出的文件不注册' },
      ),
    )
  }

  // ——— 技能 —
  const listedSkills = dto.skills ?? []
  const skills: SkillDef[] = []
  for (const name of listedSkills) {
    const skill = loadSkillFile(join(packDir, SKILLS_DIR, name), name, packId, registeredRarities, scope, errors)
    if (skill !== undefined) skills.push(skill)
  }
  for (const name of listYamlNames(join(packDir, SKILLS_DIR))) {
    if (listedSkills.includes(name)) continue
    errors.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `文件未在 pack.yml 的 skills 清单中列出，未注册：${name}.yml`,
        fileContext(join(packDir, SKILLS_DIR, `${name}.yml`)),
        [],
        { severity: 'note', suggestion: '：目录里有而清单未列出的文件不注册' },
      ),
    )
  }

  // ——— 英雄（只落数据）与依赖提示 —
  const heroes = loadHeroFiles(packDir, packId, errors)
  if (dto.dependencies !== undefined && dto.dependencies.length > 0) {
    errors.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `dependencies 本轮不解析（共 ${dto.dependencies.length} 项）：卡包完整性检查留待包管理`,
        ctx,
        ['dependencies'],
        { severity: 'note', suggestion: '：缺失依赖 ⇒ 卡包标记"不完整"、对应卡不可上阵' },
      ),
    )
  }

  const pack: Mutable<LoadedPack> = {
    packId: dto.id,
    name: dto.name,
    version: dto.version,
    builtin: dto.builtin ?? false,
    cards,
    skills,
    heroes,
    source: packDir,
  }
  if (dto.owner !== undefined) pack.owner = dto.owner
  if (rarities !== undefined) pack.rarities = rarities

  return { pack, errors }
}

// ————————————————————————————————————————————————————————
// 对外入口
// ————————————————————————————————————————————————————————

/**
 * 加载数据根下的所有卡包（卡包 + 技能包，同一套目录约定）。
 *
 * 目录不存在 / 不是目录：返回**空包表 + 一条 `pack.manifest` 错误**（不抛错）。
 */
export function loadPacks(root: string): LoadResult {
  const packs: LoadedPack[] = []
  const errors: ValidationError[] = []

  if (!isDirectory(root)) {
    errors.push(
      problem(LOAD_ERROR_CODES.packManifest, `数据根不存在或不是目录：${root}`, fileContext(root), [], {
        suggestion: `默认数据根是仓库根的 ${PACKS_ROOT}/`,
      }),
    )
    return { packs, errors }
  }

  // 预扫描英雄 id：让技能的 `heroes` 引用可以跨包校验
  const scope: LoadScope = {
    heroIds: collectHeroIds(root),
    cardIds: new Set<string>(),
    skillIds: new Set<string>(),
  }
  for (const packId of listSubdirectories(root)) {
    const outcome = loadOnePack(join(root, packId), packId, scope)
    errors.push(...outcome.errors)
    if (outcome.pack !== undefined) packs.push(outcome.pack)
  }
  return { packs, errors }
}

/** 宿主适配层的接口形态（浏览器宿主将来提供另一实现）。 */
export interface PackSource {
  readonly loadPacks: (root: string) => LoadResult
}

/** Node 宿主的唯一落点。 */
export const NodePackSource: PackSource = { loadPacks }
