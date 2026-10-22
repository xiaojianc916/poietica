/*
 * 文件类型的字形。通用 File 图标说不出这是 tsx 还是 rs，类型本身就是这一行要说的话。
 *
 * 字形取自 Material Icon Theme（MIT，见 file-marks/LICENSE）。整套 SVG 收在 file-marks/，
 * 由 Vite 当静态资源纳入构建 —— 补全之后已有上百枚，内联 path 会把组件撑成一张没法维护的字形表。
 * 文件名/后缀映射是本产品自己的知识，手写在这一个文件里。
 */

import { FILE_MARK_SOURCE, type FileMarkId } from './file-mark-assets'

const FALLBACK: FileMarkId = 'document'

/* 整名匹配：没有后缀（Makefile）或后缀说不出身份（package.json、bunfig.toml）的名字。一律小写。 */
const BY_NAME = {
  '.editorconfig': 'editorconfig',
  '.gitattributes': 'git',
  '.gitconfig': 'git',
  '.gitignore': 'git',
  '.gitkeep': 'git',
  '.gitmodules': 'git',
  '.npmignore': 'npm',
  '.npmrc': 'npm',
  '.nvmrc': 'nodejs',
  'agents.md': 'agent',
  'angular.json': 'angular',
  'biome.json': 'biome',
  'biome.jsonc': 'biome',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'bunfig.toml': 'bun',
  'cargo.lock': 'lock',
  'cargo.toml': 'rust',
  'cmakelists.txt': 'cmake',
  codeowners: 'codeowners',
  'composer.json': 'php',
  'deno.json': 'deno',
  'deno.jsonc': 'deno',
  'deno.lock': 'deno',
  dockerfile: 'docker',
  'go.mod': 'go',
  'go.sum': 'go',
  makefile: 'makefile',
  'package-lock.json': 'nodejs',
  'package.json': 'nodejs',
  pipfile: 'python',
  'pipfile.lock': 'python',
  'pnpm-lock.yaml': 'lock',
  'poetry.lock': 'lock',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'setup.cfg': 'python',
  'setup.py': 'python',
  'tsconfig.json': 'tsconfig',
  'yarn.lock': 'lock',
} as const satisfies Record<string, FileMarkId>

/* 后缀会说谎的配置名（vite.config.ts、.env.local）：排在整名之后、后缀之前，先命中先返回。 */
type PathRule = {
  readonly mark: FileMarkId
  readonly names: readonly string[]
  readonly prefixes: readonly string[]
}
const PATH_RULES: readonly PathRule[] = [
  { mark: 'tsconfig', names: ['tsconfig'], prefixes: ['tsconfig.'] },
  { mark: 'tune', names: ['.env'], prefixes: ['.env.'] },
  { mark: 'readme', names: ['readme'], prefixes: ['readme.'] },
  { mark: 'license', names: ['license', 'licence'], prefixes: ['license.', 'licence.'] },
  { mark: 'changelog', names: ['changelog', 'changes'], prefixes: ['changelog.', 'changes.'] },
  {
    mark: 'contributing',
    names: ['contributing', 'conduct', 'code_of_conduct'],
    prefixes: ['contributing.', 'conduct.', 'code_of_conduct.'],
  },
  { mark: 'architecture', names: ['architecture'], prefixes: ['architecture.'] },
  { mark: 'vite', names: ['electron.vite.config.ts', 'electron.vite.config.js'], prefixes: ['vite.config.'] },
  { mark: 'vitest', names: [], prefixes: ['vitest.config.', 'vitest.workspace.'] },
  { mark: 'eslint', names: [], prefixes: ['eslint.config.', '.eslintrc'] },
  { mark: 'prettier', names: ['.prettierignore'], prefixes: ['prettier.config.', '.prettierrc'] },
  { mark: 'tailwindcss', names: [], prefixes: ['tailwind.config.'] },
  {
    mark: 'docker',
    names: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
    prefixes: [],
  },
  { mark: 'nginx', names: ['nginx.conf'], prefixes: [] },
  { mark: 'gradle', names: ['gradle.properties'], prefixes: ['build.gradle', 'settings.gradle'] },
]
function idOfPath(raw: string): FileMarkId | undefined {
  const lower = raw.toLowerCase().replace(/\\/gu, '/')
  const base = lower.split(/[\\/]/u).at(-1) ?? lower

  if (lower.includes('.github/workflows/') && /\.ya?ml$/u.test(base)) {
    return 'github-actions-workflow'
  }

  return PATH_RULES.find((rule) => rule.names.includes(base) || rule.prefixes.some((prefix) => base.startsWith(prefix)))
    ?.mark
}

/*
 * 后缀。先长后短：`test.ts.snap` 先命中 test.ts.snap，再退回 snap、ts。
 * 同一形状的别名直接指向同一个 id，不写第二份字形。
 */
const BY_SUFFIX = {
  'test.ts': 'test-ts',
  'test.cts': 'test-ts',
  'test.mts': 'test-ts',
  'spec.ts': 'test-ts',
  'spec.cts': 'test-ts',
  'spec.mts': 'test-ts',
  'test.tsx': 'test-jsx',
  'spec.tsx': 'test-jsx',
  'test.js': 'test-js',
  'test.cjs': 'test-js',
  'test.mjs': 'test-js',
  'spec.js': 'test-js',
  'spec.cjs': 'test-js',
  'spec.mjs': 'test-js',
  'test.ts.snap': 'test-ts',
  'ts.snap': 'test-ts',
  'test.tsx.snap': 'test-jsx',
  'tsx.snap': 'test-jsx',
  'test.js.snap': 'test-js',
  'js.snap': 'test-js',
  'd.ts': 'typescript-def',
  'd.cts': 'typescript-def',
  'd.mts': 'typescript-def',
  astro: 'astro',
  avif: 'image',
  bash: 'console',
  bat: 'console',
  bmp: 'image',
  bz2: 'zip',
  c: 'c',
  cc: 'cpp',
  cer: 'certificate',
  cfg: 'settings',
  cjs: 'javascript',
  cmd: 'console',
  cmake: 'cmake',
  conf: 'settings',
  config: 'settings',
  cpp: 'cpp',
  crt: 'certificate',
  cs: 'csharp',
  csproj: 'csharp',
  css: 'css',
  csv: 'table',
  cts: 'typescript',
  cxx: 'cpp',
  dart: 'dart',
  db: 'database',
  diff: 'diff',
  dll: 'dll',
  doc: 'word',
  docx: 'word',
  ejs: 'html',
  eml: 'email',
  env: 'tune',
  erb: 'ruby',
  exe: 'exe',
  fish: 'console',
  flac: 'audio',
  gif: 'image',
  gpg: 'key',
  gql: 'graphql',
  gradle: 'gradle',
  graphql: 'graphql',
  grit: 'command',
  gz: 'zip',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  hxx: 'cpp',
  ico: 'image',
  ini: 'settings',
  java: 'java',
  jpeg: 'image',
  jpg: 'image',
  js: 'javascript',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  jsonl: 'json',
  jsx: 'react',
  key: 'key',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lib: 'lib',
  lock: 'lock',
  log: 'log',
  lua: 'lua',
  m4a: 'audio',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mk: 'makefile',
  mkv: 'video',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  mts: 'typescript',
  ndjson: 'json',
  nsh: 'command',
  nu: 'console',
  ogg: 'audio',
  otf: 'font',
  patch: 'diff',
  pcss: 'postcss',
  pdf: 'pdf',
  pem: 'key',
  pfx: 'certificate',
  php: 'php',
  png: 'image',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  prefs: 'settings',
  properties: 'settings',
  proto: 'proto',
  ps1: 'powershell',
  ps1xml: 'powershell',
  psc1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rar: 'zip',
  rb: 'ruby',
  rst: 'markdown',
  rs: 'rust',
  sass: 'sass',
  scss: 'sass',
  sh: 'console',
  sln: 'csharp',
  snap: 'test-js',
  sql: 'database',
  sqlite: 'database',
  sqlite3: 'database',
  styl: 'stylus',
  svelte: 'svelte',
  svg: 'svg',
  swift: 'swift',
  tar: 'zip',
  tf: 'terraform',
  tfvars: 'terraform',
  tif: 'image',
  tiff: 'image',
  toml: 'toml',
  ts: 'typescript',
  tsv: 'table',
  tsx: 'react_ts',
  ttf: 'font',
  txt: 'document',
  vue: 'vue',
  wasm: 'webassembly',
  wav: 'audio',
  webm: 'video',
  webmanifest: 'json',
  webp: 'image',
  woff: 'font',
  woff2: 'font',
  xls: 'table',
  xlsx: 'table',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zip: 'zip',
  zsh: 'console',
} as const satisfies Record<string, FileMarkId>

/** 一个文件名或路径配哪一枚图标；认不出来就是通用文档。 */
export function fileMarkIdOf(name: string): FileMarkId {
  return knownFileMarkOf(name) ?? FALLBACK
}

/**
 * 认得出来才交回图标，认不出来是 undefined。正文里「这串行内代码像不像一个文件名」要的是这一问（prose/file-ref.ts）：
 * 退回通用文档的那一格答的是「不知道」，不能当成「是文件」。
 */
export function knownFileMarkOf(name: string): FileMarkId | undefined {
  const lower = name.toLowerCase()
  const base = lower.split(/[\\/]/u).at(-1) ?? lower
  const named = BY_NAME[base as keyof typeof BY_NAME]

  if (named !== undefined) {
    return named
  }

  const byPath = idOfPath(lower)

  if (byPath !== undefined) {
    return byPath
  }

  const parts = base.split('.')
  for (let at = 1; at < parts.length; at += 1) {
    const suffix = parts.slice(at).join('.')
    const mark = BY_SUFFIX[suffix as keyof typeof BY_SUFFIX]
    if (mark !== undefined) {
      return mark
    }
  }

  return undefined
}

export function FileTypeMark({ className, name }: { readonly className: string; readonly name: string }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      decoding="async"
      data-file-mark=""
      draggable={false}
      src={FILE_MARK_SOURCE[fileMarkIdOf(name)]}
    />
  )
}
