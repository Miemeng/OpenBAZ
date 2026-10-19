/**
 * L3 · 阵容文件的**宿主入口（含 IO）** —— 契约 / 校验 / 装配已拆到
 * [cards/deck.ts](../cards/deck.ts)（ `` ）。
 *
 * 本文件只做两件"必须碰文件系统"的事：
 *  ① `readDeckFile()` —— 读一份 `decks/*.yml` 的文本（读不到就产出一条 `error`，不抛）；
 *  ② `loadDecks()` —— 一次装满：`loadPacks(roots)` → 注册表 → 解析两份阵容 → 语义校验 → 装配 → 几何校验。
 * 其余名字**原样 re-export**，于是 `simulator/run.ts` / `simulator/validate.ts` 的调用面一行都不用改。
 *
 * ⚠️ 位置之所以还在 `simulator/`：它 import 了 `cards/loader.ts`（含 `node:fs`），
 * 而 `cards/` 的纯逻辑白名单（`eslint.config.js`）要求能在浏览器宿主运行。
 * **浏览器侧要用的是 `cards/deck.ts`**（几何校验 / id 注册校验 / 血量三级优先），不要 import 本文件。
 */

import { readFileSync } from 'node:fs'
import { CardRegistry } from '../cards/registry.ts'
import { loadPacks } from '../cards/loader.ts'
import { problem } from '../cards/schema.ts'
import type { ValidationContext } from '../cards/schema.ts'
import type { LoadedPack, ValidationError } from '../cards/types.ts'
import {
  checkDeckGeometry,
  deckNameFromPath,
  parseDeckText,
  resolveDeck,
  validateDeck,
  type ParsedDeck,
  type ResolvedDeck,
} from '../cards/deck.ts'

// 纯逻辑部分**原样转出**：调用方（CLI / 脚本）继续从 `simulator/deck.ts` 取这些名字即可。
export {
  checkDeckGeometry,
  deckDtoSchema,
  deckNameFromPath,
  hasFatal,
  parseDeckText,
  resolveDeck,
  validateDeck,
} from '../cards/deck.ts'
export type { DeckCardDto, DeckDto, ParsedDeck, ResolvedDeck } from '../cards/deck.ts'

/** 从磁盘读并解析一份阵容文件。 */
export function readDeckFile(filePath: string): ParsedDeck {
  const file = filePath.replace(/\\/g, '/')
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const ctx: ValidationContext = { file, positions: new Map() }
    return {
      ctx,
      errors: [
        problem('schema.invalid', `读不到阵容文件：${filePath}`, ctx, [], {
          suggestion: `原因：${error instanceof Error ? error.message : String(error)}`,
        }),
      ],
    }
  }
  return parseDeckText(text, file)
}

/* ------------------------------------------------------------------ *
 * 宿主入口：一次装载（读 packs + 解析两份阵容）
 * ------------------------------------------------------------------ */

/** 一次装满的结果：注册表 + 数据根 + 两份阵容（任一处 `error` ⇒ 调用方中止）。 */
export interface LoadedDecks {
  readonly registry: CardRegistry
  readonly packs: readonly LoadedPack[]
  readonly deckA?: ResolvedDeck | undefined
  readonly deckB?: ResolvedDeck | undefined
  readonly errors: readonly ValidationError[]
}

/**
 * 装一次对局所需的全部数据：`loadPacks(roots)` → 注册表 → 解析两份阵容 → 语义校验 → 装配 → 几何校验。
 *
 * @param roots 数据根（可多个，按序加载；后加载者的同 id 条目按读取层口径处理）
 * @param deckAPath `--deckA` 的路径
 * @param deckBPath `--deckB` 的路径
 */
export function loadDecks(
  roots: readonly string[],
  deckAPath: string,
  deckBPath: string,
  locale?: string,
): LoadedDecks {
  const errors: ValidationError[] = []
  const packs: LoadedPack[] = []
  for (const root of roots) {
    const result = loadPacks(root, locale === undefined ? {} : { locale })
    packs.push(...result.packs)
    errors.push(...result.errors)
  }

  const registry = new CardRegistry()
  registry.replaceAll(packs)

  const parsedA = readDeckFile(deckAPath)
  const parsedB = readDeckFile(deckBPath)
  errors.push(...parsedA.errors, ...parsedB.errors)

  let deckA: ResolvedDeck | undefined
  let deckB: ResolvedDeck | undefined

  if (parsedA.dto !== undefined) {
    errors.push(...validateDeck(parsedA.dto, registry, parsedA.ctx))
    deckA = resolveDeck(parsedA.dto, registry, deckNameFromPath(deckAPath))
  }
  if (parsedB.dto !== undefined) {
    errors.push(...validateDeck(parsedB.dto, registry, parsedB.ctx))
    deckB = resolveDeck(parsedB.dto, registry, deckNameFromPath(deckBPath))
  }

  if (deckA !== undefined) {
    for (const geometryError of checkDeckGeometry(1, deckA)) {
      errors.push(problem('schema.invalid', `阵容 A：${geometryError.message}`, parsedA.ctx, []))
    }
  }
  if (deckB !== undefined) {
    for (const geometryError of checkDeckGeometry(2, deckB)) {
      errors.push(problem('schema.invalid', `阵容 B：${geometryError.message}`, parsedB.ctx, []))
    }
  }

  return { registry, packs, deckA, deckB, errors }
}
