/*
 * 集成标记：插件目录里那枚品牌图标。
 *
 * 界面投影，不进入插件清单、安装账本或 MCP 配置；认不出交回 undefined，
 * 兜底归调用点。
 *
 * 相对 URL 由 Vite 纳入构建产物，因此不需要 SVG 模块声明。
 */

export interface IntegrationMark {
  readonly src: string
  readonly background: string
}

/* URL 必须是字面量：Vite 的资源内联只认写死的相对路径。 */
const ICONS = {
  automation: {
    src: new URL('./integration-marks/automation.svg', import.meta.url).href,
    background: '#FFF0E8',
  },
  chromeDevTools: {
    src: new URL('./integration-marks/chrome-devtools.svg', import.meta.url).href,
    background: '#E8F1FE',
  },
  context7: {
    src: new URL('./integration-marks/context7.svg', import.meta.url).href,
    background: '#F1F1F1',
  },
  deepWiki: {
    src: new URL('./integration-marks/deepwiki.svg', import.meta.url).href,
    background: '#F1ECFF',
  },
  docx: {
    src: new URL('./integration-marks/docx.svg', import.meta.url).href,
    background: '#EAF2FF',
  },
  filesystem: {
    src: new URL('./integration-marks/filesystem.svg', import.meta.url).href,
    background: '#FFF4DD',
  },
  github: {
    src: new URL('./integration-marks/github.svg', import.meta.url).href,
    background: '#EEF0F2',
  },
  kimiDatasource: {
    src: new URL('./integration-marks/kimi-datasource.svg', import.meta.url).href,
    background: '#E6F7FB',
  },
  kimiWebBridge: {
    src: new URL('./integration-marks/kimi-webbridge.svg', import.meta.url).href,
    background: '#EAF2FF',
  },
  mcp: {
    src: new URL('./integration-marks/mcp.svg', import.meta.url).href,
    background: '#F1F2F4',
  },
  memory: {
    src: new URL('./integration-marks/memory.svg', import.meta.url).href,
    background: '#F1ECFF',
  },
  modernWebGuidance: {
    src: new URL('./integration-marks/modern-web-guidance.svg', import.meta.url).href,
    background: '#E8F7FF',
  },
  pdf: {
    src: new URL('./integration-marks/pdf.svg', import.meta.url).href,
    background: '#FDEBEC',
  },
  playwright: {
    src: new URL('./integration-marks/playwright.svg', import.meta.url).href,
    background: '#ECF8EE',
  },
  pptx: {
    src: new URL('./integration-marks/pptx.svg', import.meta.url).href,
    background: '#FFF0E8',
  },
  sequentialThinking: {
    src: new URL('./integration-marks/sequential-thinking.svg', import.meta.url).href,
    background: '#E7F3FF',
  },
  skillCreator: {
    src: new URL('./integration-marks/skill-creator.svg', import.meta.url).href,
    background: '#FFF4DD',
  },
  superpowers: {
    src: new URL('./integration-marks/superpowers.svg', import.meta.url).href,
    background: '#FFF8DB',
  },
  vercel: {
    src: new URL('./integration-marks/vercel.svg', import.meta.url).href,
    background: '#F1F1F1',
  },
  xlsx: {
    src: new URL('./integration-marks/xlsx.svg', import.meta.url).href,
    background: '#EAF7EE',
  },
} as const satisfies Record<string, IntegrationMark>

type IntegrationMarkKey = keyof typeof ICONS

interface AliasRule {
  readonly icon: IntegrationMarkKey
  readonly names: readonly string[]
}

const ALIASES = [
  {
    icon: 'kimiWebBridge',
    names: ['kimi-webbridge', 'kimi-web-bridge', 'webbridge'],
  },
  {
    icon: 'kimiDatasource',
    names: ['kimi-datasource', 'kimi-data-source', 'datasource'],
  },
  {
    icon: 'superpowers',
    names: ['superpowers'],
  },
  {
    icon: 'vercel',
    names: ['vercel-plugin', 'vercel'],
  },
  {
    icon: 'modernWebGuidance',
    names: ['modern-web-guidance'],
  },
  {
    icon: 'context7',
    names: ['context7'],
  },
  {
    icon: 'deepWiki',
    names: ['deepwiki', 'deep-wiki'],
  },
  {
    icon: 'chromeDevTools',
    names: ['chrome-devtools', 'chrome-devtools-mcp'],
  },
  {
    icon: 'playwright',
    names: ['playwright', 'playwright-mcp'],
  },
  {
    icon: 'github',
    names: ['github', 'github-mcp'],
  },
  {
    icon: 'sequentialThinking',
    names: ['sequential-thinking', 'sequentialthinking'],
  },
  {
    icon: 'filesystem',
    names: ['filesystem', 'file-system'],
  },
  {
    icon: 'memory',
    names: ['memory', 'server-memory'],
  },
  {
    icon: 'docx',
    names: ['docx', 'word-document', 'microsoft-word'],
  },
  {
    icon: 'pdf',
    names: ['pdf'],
  },
  {
    icon: 'pptx',
    names: ['pptx', 'powerpoint'],
  },
  {
    icon: 'xlsx',
    names: ['xlsx', 'excel', 'spreadsheet'],
  },
  {
    icon: 'skillCreator',
    names: ['skill-creator', 'skill-builder'],
  },
  {
    icon: 'mcp',
    names: ['mcp-builder'],
  },
  {
    icon: 'automation',
    names: ['poietica-automations', 'poietica-automation', 'automations', 'automation', 'workflow'],
  },
  {
    icon: 'mcp',
    names: ['model-context-protocol', 'mcp'],
  },
] as const satisfies readonly AliasRule[]

function normalise(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function containsAlias(value: string, alias: string): boolean {
  return (
    value === alias ||
    value.startsWith(`${alias}-`) ||
    value.endsWith(`-${alias}`) ||
    value.includes(`-${alias}-`)
  )
}

/** 认得出就给那家的标记；认不出交回 undefined，兜底由调用点自己决定。 */
export function integrationMarkFor(...names: readonly string[]): IntegrationMark | undefined {
  const candidates = names.map(normalise).filter((candidate) => candidate !== '')

  for (const rule of ALIASES) {
    if (
      candidates.some((candidate) => rule.names.some((alias) => containsAlias(candidate, alias)))
    ) {
      return ICONS[rule.icon]
    }
  }

  return undefined
}
