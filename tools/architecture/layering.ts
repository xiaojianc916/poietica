/**
 * 分层表：环序即依赖方向 —— 只允许高环指向低环，同环之间不许有边。
 *
 * 环语义对齐目标态（Architecture/poietica-architecture/LAYERS.md 的 R0–R4）；
 * 与目标表的已知偏差，均登记在案：design-system 单独成环且低于领域（review 与
 * workspace 的 store 持有 SplitterActivity 类型）；agent-contract /
 * agent-catalog 作为端口与档案词汇单独成环，待并入各领域包后消失；workspace
 * 尚未拆出 workspace-ui。
 */

export type Ring = { readonly name: string; readonly members: readonly string[] }

export const TYPESCRIPT_RINGS: readonly Ring[] = [
  { name: 'contract', members: ['@poietica/contract'] },
  { name: 'vocabulary', members: ['@poietica/problem', '@poietica/external-store'] },
  { name: 'visual-vocabulary', members: ['@poietica/design-system'] },
  { name: 'agent-vocabulary', members: ['@poietica/agent-contract', '@poietica/agent-catalog'] },
  {
    name: 'domain',
    members: [
      '@poietica/conversation',
      '@poietica/automation',
      '@poietica/browser',
      '@poietica/extension',
      '@poietica/review',
      '@poietica/settings',
      '@poietica/update',
    ],
  },
  { name: 'adapter', members: ['@poietica/native-bridge'] },
  {
    name: 'surfaces',
    members: [
      '@poietica/conversation-ui',
      '@poietica/automation-ui',
      '@poietica/browser-ui',
      '@poietica/extension-ui',
      '@poietica/settings-ui',
      '@poietica/review-ui',
      '@poietica/workspace',
    ],
  },
  { name: 'composition', members: ['@poietica/desktop'] },
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
  { name: 'composition', members: ['poietica'] },
]

/** 工具与测试工作区不进分层：它们按定义要能引用任何一层。 */
export const UNLAYERED_DIRECTORIES: readonly string[] = ['tests', 'tools']

/** 只有这几个包允许直接触碎 Tauri 客户端 API：contract 是 tauri-specta 的产出物，native-bridge 是唯一手写使用者。 */
export const HOST_AWARE_PACKAGES: readonly string[] = [
  '@poietica/contract',
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
  '@poietica/contract',
  '@poietica/problem',
  '@poietica/external-store',
  '@poietica/agent-contract',
  '@poietica/agent-catalog',
  '@poietica/conversation',
  '@poietica/automation',
  '@poietica/browser',
  '@poietica/extension',
  '@poietica/review',
  '@poietica/settings',
  '@poietica/update',
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
