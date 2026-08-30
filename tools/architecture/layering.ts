/** 分层表：环序即依赖方向 —— 只允许高环指向低环，同环之间不许有边。 */

export type Ring = { readonly name: string; readonly members: readonly string[] }

export const TYPESCRIPT_RINGS: readonly Ring[] = [
  { name: 'contract', members: ['@poietica/contract'] },
  { name: 'foundation', members: ['@poietica/problem', '@poietica/design-system'] },
  { name: 'protocol', members: ['@poietica/agent-contract'] },
  {
    name: 'domain',
    members: ['@poietica/conversation', '@poietica/agent-catalog', '@poietica/review'],
  },
  { name: 'adapter', members: ['@poietica/native-bridge'] },
  {
    name: 'feature',
    members: [
      '@poietica/conversation-ui',
      '@poietica/automations',
      '@poietica/browser',
      '@poietica/plugins',
      '@poietica/settings',
      '@poietica/workspace',
    ],
  },
  { name: 'application', members: ['@poietica/desktop'] },
]

export const CARGO_RINGS: readonly Ring[] = [
  { name: 'vocabulary', members: ['poietica-problem', 'poietica-time'] },
  { name: 'domain', members: ['poietica-asset', 'poietica-conversation'] },
  {
    name: 'capability',
    members: [
      'poietica-agent-runtime-native',
      'poietica-browser-native',
      'poietica-git-native',
      'poietica-kap-client',
      'poietica-ledger',
      'poietica-plugin-host-native',
      'poietica-update-native',
    ],
  },
  { name: 'application', members: ['poietica'] },
]

/** 工具与测试工作区不进分层：它们按定义要能引用任何一层。 */
export const UNLAYERED_DIRECTORIES: readonly string[] = ['tests', 'tools']

/** 只有这几个包允许直接触碎 Tauri 客户端 API；contract 在内，它是 tauri-specta 的产出物。 */
export const HOST_AWARE_PACKAGES: readonly string[] = [
  '@poietica/contract',
  '@poietica/desktop',
  '@poietica/native-bridge',
]

/** 这些 crate 不许知道自己跑在 Tauri 里。 */
export const HOST_AGNOSTIC_CRATES: readonly string[] = [
  'poietica-agent-runtime-native',
  'poietica-browser-native',
  'poietica-asset',
  'poietica-conversation',
  'poietica-git-native',
  'poietica-kap-client',
  'poietica-ledger',
  'poietica-plugin-host-native',
  'poietica-problem',
  'poietica-time',
]

/** 词汇与领域包里不许出现 UI 框架。 */
export const FRAMEWORK_FREE_PACKAGES: readonly string[] = [
  '@poietica/conversation',
  '@poietica/agent-catalog',
  '@poietica/contract',
  '@poietica/problem',
]

export const FRAMEWORK_SPECIFIERS: readonly string[] = ['react', 'react-dom', 'react/jsx-runtime']

/** 按技术类型命名的目录一律不许：目录要回答"这是什么能力"。 */
export const FORBIDDEN_DIRECTORY_NAMES: readonly string[] = [
  'application',
  'common',
  'components',
  'domain',
  'helpers',
  'lib',
  'managers',
  'ports',
  'presentation',
  'services',
  'state',
  'stores',
  'types',
  'utils',
]

export function ringOf(rings: readonly Ring[], member: string): number {
  return rings.findIndex((ring) => ring.members.includes(member))
}
