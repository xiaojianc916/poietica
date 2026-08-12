/* Managed by root refactor.mjs. */

/*
 * 图标是界面投影，不进入插件清单、安装账本或 MCP 配置。
 *
 * 每一个 URL 都是静态的相对路径，Vite 会把对应 SVG 纳入构建产物。
 * 这里不使用 SVG 模块默认导入，因此不需要额外的 assets.d.ts。
 */

const automationIcon = new URL('../assets/integration-icons/automation.svg', import.meta.url).href
const chromeDevToolsIcon = new URL(
  '../assets/integration-icons/chrome-devtools.svg',
  import.meta.url,
).href
const context7Icon = new URL('../assets/integration-icons/context7.svg', import.meta.url).href
const deepWikiIcon = new URL('../assets/integration-icons/deepwiki.svg', import.meta.url).href
const docxIcon = new URL('../assets/integration-icons/docx.svg', import.meta.url).href
const filesystemIcon = new URL('../assets/integration-icons/filesystem.svg', import.meta.url).href
const githubIcon = new URL('../assets/integration-icons/github.svg', import.meta.url).href
const kimiDatasourceIcon = new URL(
  '../assets/integration-icons/kimi-datasource.svg',
  import.meta.url,
).href
const kimiWebBridgeIcon = new URL('../assets/integration-icons/kimi-webbridge.svg', import.meta.url)
  .href
const mcpIcon = new URL('../assets/integration-icons/mcp.svg', import.meta.url).href
const memoryIcon = new URL('../assets/integration-icons/memory.svg', import.meta.url).href
const modernWebGuidanceIcon = new URL(
  '../assets/integration-icons/modern-web-guidance.svg',
  import.meta.url,
).href
const pdfIcon = new URL('../assets/integration-icons/pdf.svg', import.meta.url).href
const playwrightIcon = new URL('../assets/integration-icons/playwright.svg', import.meta.url).href
const pptxIcon = new URL('../assets/integration-icons/pptx.svg', import.meta.url).href
const sequentialThinkingIcon = new URL(
  '../assets/integration-icons/sequential-thinking.svg',
  import.meta.url,
).href
const skillCreatorIcon = new URL('../assets/integration-icons/skill-creator.svg', import.meta.url)
  .href
const superpowersIcon = new URL('../assets/integration-icons/superpowers.svg', import.meta.url).href
const vercelIcon = new URL('../assets/integration-icons/vercel.svg', import.meta.url).href
const xlsxIcon = new URL('../assets/integration-icons/xlsx.svg', import.meta.url).href

export interface PluginIconAsset {
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
} as const satisfies Record<string, PluginIconAsset>

type PluginIconKey = keyof typeof ICONS

interface AliasRule {
  readonly icon: PluginIconKey
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

export function pluginIconFor(id: string, displayName: string): PluginIconAsset | undefined {
  const candidates = [normalise(id), normalise(displayName)].filter((candidate) => candidate !== '')

  for (const rule of ALIASES) {
    if (
      candidates.some((candidate) => rule.names.some((alias) => containsAlias(candidate, alias)))
    ) {
      return ICONS[rule.icon]
    }
  }

  return undefined
}
