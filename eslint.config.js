// 模块边界强制：单包形态下，框架设计  的架构约束靠本文件 + 类型检查强制
// 反向用例：故意在 engine/ 里 import node:fs，必须被 lint 拦下

// 书写约定（踩过的坑，务必遵守）：本文件里不要在注释中写斜杠加星号的序列（注释开始符），
// 也不要写反引号包住含该序列的 glob（例如通配路径那种写法）。JS 会把注释里的该序列
// 当作新的注释开始符；一旦后面缺少配对的结束符，注释会吞掉后续代码，
// 并报出与真实位置无关的 "SyntaxError: Unexpected token '.'"。
// 本文件因此统一用行注释、注释内不写反引号。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 运行时导入其他层 —— 仅允许 import type（类型擦除后无运行时边）
const layerImportPatterns = {
  importNames: ['*'],
  group: [
    '../cards/*',
    '../cards/**',
    '../client/*',
    '../client/**',
    '../simulator/*',
    '../simulator/**',
    'cards/*',
    'cards/**',
    'client/*',
    'client/**',
    'simulator/*',
    'simulator/**',
  ],
  allowTypeImports: true,
  message:
    '违反依赖方向：engine/ 不得运行时导入其他层，只允许 import type。',
}

// 宿主全局：engine/ 与 cards/ 纯逻辑必须同时可跑在 Node 与浏览器

// 用 no-restricted-globals 拦，不能靠"globals 置 off + no-undef"：
// typescript-eslint 的 eslint-recommended 已把 no-undef 对 TypeScript 文件关掉
// （见 @typescript-eslint/eslint-plugin/dist/configs/eslint-recommended-raw.js 第 36 行），
// 那样写会一条都不报——"看起来很严、实际全放行"的假绿。

// 细则：该规则只报运行时引用，TypeScript 类型注解里的同名类型会被忽略，
// 所以 fetch / document 这类同时也是 DOM 类型名的全局不会误报。
const hostGlobals = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'process',
]

// 宿主全局规则：checkGlobalObject 连 globalThis.process / self.fetch 一起报
// （默认已检查 globalThis / self / window 三个全局对象）
const restrictHostGlobals = [
  'error',
  { globals: hostGlobals, checkGlobalObject: true },
]

export default [
  { ignores: ['node_modules/**', 'dist/**', 'desktop/dist/**', 'release/**', 'tools/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 桌面主进程 / 预加载是**CommonJS 纯 JS**（《审阅》§AI.3 = A）：给它们 Node 的公共全局，
  // 否则 js.configs.recommended 的 no-undef 会把 require / module / process 全报一遍。
  // 同时要关掉 `@typescript-eslint/no-require-imports`：这条规则是为 ESM/TS 设计的，
  // 在 `.cjs` 里 `require()` 是**正确写法**（主进程刻意不引入构建步骤）。
  {
    files: ['desktop/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        // Node 18+ 的全局（Electron 主进程里直接用，不 import）
        Response: 'readonly',
        Request: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // 全体：确定性+ 只写可擦除语法
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: '禁止 new Date()：确定性优先。' },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: '禁止 Math.random()：随机必须走 engine/rng.ts 的唯一入口。' },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: '禁止 Date.now()：确定性优先。' },
        { selector: "TSEnumDeclaration", message: '禁 enum：Node 类型擦除不支持。' },
        { selector: "Decorator", message: '禁装饰器：Node 类型擦除不支持。' },
        { selector: "TSParameterProperty", message: '禁构造函数参数属性：Node 类型擦除不支持。' },
        { selector: "TSImportEqualsDeclaration", message: '禁 import 别名（import = ）：Node 类型擦除不支持。' },
      ],
    },
  },

  // client/：Vite 标准的环境声明文件用三斜线引用（vite/client），这是官方推荐写法、
  // 不能用 import 替代，故只对 .d.ts 关掉这条规则。
  {
    files: ['client/**/*.d.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },

  // engine/：零依赖 + 零宿主 API
  {
    files: ['engine/**/*.ts'],
    languageOptions: {
      // 类型感知解析：no-restricted-imports 的 allowTypeImports 只在类型信息可用时生效，
      // 否则会把合法的 import type 一并拦下（与 的"仅允许 import type"冲突）。
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'vite.config.ts', 'eslint.config.js'],
        },
        // 用 fileURLToPath 而非 import.meta.dirname：后者需要较新的 Node
        tsconfigRootDir: dirname(fileURLToPath(import.meta.url)),
      },
    },
    rules: {
      'no-restricted-globals': restrictHostGlobals,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs',
              message: 'engine/ 零依赖：禁止任何 node:* 内置模块。',
            },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'url', 'util', 'child_process', 'crypto', 'http', 'https', 'worker_threads', 'events', 'stream', 'zlib', 'readline'],
              message: 'engine/ 零依赖：禁止 Node 内置模块。',
            },
            {
              group: ['zod', 'js-yaml', 'chokidar', 'yaml'],
              message: 'engine/ 零依赖：禁止第三方包运行时值。',
            },
            layerImportPatterns,
          ],
        },
      ],
    },
  },

  // cards/ 纯逻辑：不碰 node:*，保证浏览器宿主可运行；cards/loader 等宿主适配层不在此列
  {
    files: [
      'cards/types.ts',
      'cards/schema.ts',
      'cards/schema/**/*.ts',
      'cards/yaml-positions.ts',
      'cards/map.ts',
      'cards/registry.ts',
      'cards/glossary.ts',
      'cards/template.ts',
    ],
    rules: {
      'no-restricted-globals': restrictHostGlobals,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'cards/ 纯逻辑不得引用 node:*：必须能在浏览器宿主运行。',
            },
          ],
        },
      ],
    },
  },

  // client/：表现层。它是 DOM 层，**允许**用 window / document（故不套 hostGlobals 规则），
  // 但**不得 import node:*** —— 同一份源码将来要能换宿主（浏览器 / Electron），
  // 靠规则保证而不是靠"记得别这么写"（ /  ``）。
  // 文件读写 / 目录遍历一律走宿主中介（dev middleware 或 Electron 主进程）。
  {
    files: ['client/**/*.ts', 'client/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'client/ 不得引用 node:*：表现层必须能在浏览器宿主运行。文件读写请走宿主中介。',
            },
          ],
        },
      ],
    },
  },
]
