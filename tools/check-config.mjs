// 零源码期的配置验收：断言两份 tsconfig 的关键不变量。
// 为什么不用 `tsc --showConfig`：零输入文件时 tsc 会 exit 1（TS18003），
// 那正是骨架期的常态——于是"配置是否有效"会被"有没有源码"掩盖掉（假绿）。
// 本脚本只读文件、不开子进程，把这两件事分开。
// 等第一个 .ts 落地后 `npm run typecheck` 恢复正常，本脚本可以删。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'

/** tsconfig 是 JSONC（允许注释与尾逗号），先剥掉再解析 */
function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text)))
}

function stripComments(text) {
  let out = ''
  let inString = false
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        i += 1
      } else if (char === quote) {
        inString = false
      }
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += char
  }
  return out
}

function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1')
}

/** 浅合并一层 extends（本项目只用到一层） */
function loadConfig(file) {
  const own = parseJsonc(readFileSync(join(root, file), 'utf8'))
  if (!own.extends) return own
  const base = loadConfig(own.extends)
  return {
    ...base,
    ...own,
    compilerOptions: { ...(base.compilerOptions ?? {}), ...(own.compilerOptions ?? {}) },
  }
}

const failures = []
const notes = []

function verify({ label, file, expect }) {
  let config
  try {
    config = loadConfig(file)
  } catch (error) {
    failures.push({ label, problems: [`无法读取 / 解析：${error.message}`] })
    return
  }
  const options = config.compilerOptions ?? {}
  const problems = []

  for (const key of expect.has ?? []) {
    if (!Object.hasOwn(options, key)) problems.push(`缺少 compilerOptions.${key}`)
  }
  for (const key of expect.no ?? []) {
    if (Object.hasOwn(options, key)) {
      problems.push(`不应出现 compilerOptions.${key}（Node 不读 tsconfig，别名在 CLI 侧必然失败）`)
    }
  }
  if (expect.nodeGlobals === true) {
    if (!Array.isArray(options.types) || !options.types.includes('node')) {
      problems.push(`types 应包含 "node"，实际 ${JSON.stringify(options.types)}`)
    }
  }
  if (expect.nodeGlobals === false) {
    if (!Array.isArray(options.types) || options.types.length !== 0) {
      problems.push(`types 应为空数组（表现层不该看见 Node 全局），实际 ${JSON.stringify(options.types)}`)
    }
  }
  for (const [key, value] of Object.entries(expect.equals ?? {})) {
    if (JSON.stringify(options[key]) !== JSON.stringify(value)) {
      problems.push(`compilerOptions.${key} 应为 ${JSON.stringify(value)}，实际 ${JSON.stringify(options[key])}`)
    }
  }

  if (problems.length > 0) failures.push({ label, problems })
  else notes.push(`${label} ✓`)
}

// eslint.config.js 的加载期陷阱（本仓库真实踩过，见 AGENT.md §5.4）：
// 块注释里如果出现"注释开始符 + 反引号 + 含注释结束符的 glob + 反引号"这种组合，
// Node 解析该文件时会报与真实位置无关的 "SyntaxError: Unexpected token '.'"，
// 表现为 `npm run lint` 整份配置加载失败——而且这条路径**不经过任何 ESLint 规则**，
// 所以只有真正加载一次才能发现。下面用一个极窄的正则把它拦在配置验收阶段：
// 匹配 JSDoc 结束与非 JSDoc 注释开始的组合（星号-斜杠-星号-星号），后接反引号、再接点。
// 注意不能写成"斜杠-星号-星号-反引号-点"：那会与 `**/*.ts` 里的片段重名，产生误报；
// 也不要把 `*/` 与 `/*` 分开匹配：正文里**加粗**结尾紧跟 `/*` 是合法写法，会误报。
const DANGEROUS_COMMENT_PATTERN = /\*\/\*\*`\./
function checkEslintConfig(file) {
  const label = `${file}（加载期陷阱）`
  let text
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch (error) {
    failures.push({ label, problems: [`无法读取：${error.message}`] })
    return
  }
  if (DANGEROUS_COMMENT_PATTERN.test(text)) {
    failures.push({
      label,
      problems: [
        '注释里出现"注释开始符 + 反引号 + 含注释结束符的 glob + 反引号"组合；',
        'JS 会把它当作新的注释开始符，导致解析报出与真实位置无关的 Unexpected token。',
        '改法：注释里不要写注释开始符序列，也不要写反引号包住含该序列的 glob。',
      ],
    })
  } else {
    notes.push(`${label} ✓（未发现该陷阱）`)
  }
}

verify({
  label: 'tsconfig.json（Node 侧）',
  file: 'tsconfig.json',
  expect: {
    nodeGlobals: true,
    has: ['noEmit', 'allowImportingTsExtensions', 'erasableSyntaxOnly', 'verbatimModuleSyntax'],
    no: ['paths'],
    equals: { module: 'nodenext', target: 'esnext' },
  },
})

verify({
  label: 'tsconfig.client.json（表现层）',
  file: 'tsconfig.client.json',
  expect: {
    nodeGlobals: false,
    has: ['noEmit', 'allowImportingTsExtensions', 'erasableSyntaxOnly', 'verbatimModuleSyntax'],
    no: ['paths'],
    equals: { jsx: 'react-jsx' },
  },
})

checkEslintConfig('eslint.config.js')

for (const note of notes) console.log(`  ${note}`)
if (failures.length > 0) {
  console.error('\n配置验收未通过：')
  for (const { label, problems } of failures) {
    console.error(`\n[${label}]`)
    for (const problem of problems) console.error(`  - ${problem}`)
  }
  process.exitCode = 1
} else {
  console.log('\n配置验收通过（零源码期：配置本身有效；源码类型检查待第一个 .ts 落地）')
}
