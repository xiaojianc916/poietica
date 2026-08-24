/*
 * 集成标记：插件目录里那枚品牌图标。
 *
 * 界面投影，不进入插件清单、安装账本或 MCP 配置；认不出交回 undefined，
 * 兜底归调用点。
 *
 * 相对 URL 由 Vite 纳入构建产物，因此不需要 SVG 模块声明。
 */

const automationIcon = new URL('./integration-marks/automation.svg', import.meta.url).href
const chromeDevToolsIcon = new URL('./integration-marks/chrome-devtools.svg', import.meta.url).href
const context7Icon = new URL('./integration-marks/context7.svg', import.meta.url).href
const deepWikiIcon = new URL('./integration-marks/deepwiki.svg', import.meta.url).href
const docxIcon = new URL('./integration-marks/docx.svg', import.meta.url).href
const filesystemIcon = new URL('./integration-marks/filesystem.svg', import.meta.url).href
const githubIcon = new URL('./integration-marks/github.svg', import.meta.url).href
const kimiDatasourceIcon = new URL('./integration-marks/kimi-datasource.svg', import.meta.url).href
const kimiWebBridgeIcon = new URL('./integration-marks/kimi-webbridge.svg', import.meta.url).href
const mcpIcon = new URL('./integration-marks/mcp.svg', import.meta.url).href
const memoryIcon = new URL('./integration-marks/memory.svg', import.meta.url).href
const modernWebGuidanceIcon = new URL(
  './integration-marks/modern-web-guidance.svg',
  import.meta.url,
).href
const pdfIcon = new URL('./integration-marks/pdf.svg', import.meta.url).href
const playwrightIcon = new URL('./integration-marks/playwright.svg', import.meta.url).href
const pptxIcon = new URL('./integration-marks/pptx.svg', import.meta.url).href
const sequentialThinkingIcon = new URL(
  './integration-marks/sequential-thinking.svg',
  import.meta.url,
).href
const skillCreatorIcon = new URL('./integration-marks/skill-creator.svg', import.meta.url).href
const superpowersIcon = new URL('./integration-marks/superpowers.svg', import.meta.url).href
const vercelIcon = new URL('./integration-marks/vercel.svg', import.meta.url).href
const xlsxIcon = new URL('./integration-marks/xlsx.svg', import.meta.url).href

export interface IntegrationMark {
  readonly src: string
  readonly background: string
}

const ICONS = {
  automation: {
    src: automationIcon,
    background: '#FFF0E8',
  },
  chromeDevTools: {
    src: chromeDevToolsIcon,
    background: '#E8F1FE',
  },
  context7: {
    src: context7Icon,
    background: '#F1F1F1',
  },
  deepWiki: {
    src: deepWikiIcon,
    background: '#F1ECFF',
  },
  docx: {
    src: docxIcon,
    background: '#EAF2FF',
  },
  filesystem: {
    src: filesystemIcon,
    background: '#FFF4DD',
  },
  github: {
    src: githubIcon,
    background: '#EEF0F2',
  },
  kimiDatasource: {
    src: kimiDatasourceIcon,
    background: '#E6F7FB',
  },
  kimiWebBridge: {
    src: kimiWebBridgeIcon,
    background: '#EAF2FF',
  },
  mcp: {
    src: mcpIcon,
    background: '#F1F2F4',
  },
  memory: {
    src: memoryIcon,
    background: '#F1ECFF',
  },
  modernWebGuidance: {
    src: modernWebGuidanceIcon,
    background: '#E8F7FF',
  },
  pdf: {
    src: pdfIcon,
    background: '#FDEBEC',
  },
  playwright: {
    src: playwrightIcon,
    background: '#ECF8EE',
  },
  pptx: {
    src: pptxIcon,
    background: '#FFF0E8',
  },
  sequentialThinking: {
    src: sequentialThinkingIcon,
    background: '#E7F3FF',
  },
  skillCreator: {
    src: skillCreatorIcon,
    background: '#FFF4DD',
  },
  superpowers: {
    src: superpowersIcon,
    background: '#FFF8DB',
  },
  vercel: {
    src: vercelIcon,
    background: '#F1F1F1',
  },
  xlsx: {
    src: xlsxIcon,
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
