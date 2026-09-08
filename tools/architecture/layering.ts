/**
 * 层组控制宿主方向；同组领域边必须显式登记。
 * 纯入口由传递文件图约束，纵切领域包可以包含独立视图入口。
 */
export type Ring = { readonly name: string; readonly members: readonly string[] }
export const TYPESCRIPT_RINGS: readonly Ring[] = [
  { name: 'contract', members: ['@poietica/contract'] },
  {
    name: 'foundation',
    members: [
      '@poietica/problem',
      '@poietica/external-store',
      '@poietica/transcript',
      '@poietica/agent-catalog',
      '@poietica/design-system',
    ],
  },
  {
    name: 'feature',
    members: [
      '@poietica/library',
      '@poietica/browser',
      '@poietica/review',
      '@poietica/terminal',
      '@poietica/conversation',
      '@poietica/extension',
      '@poietica/update',
      '@poietica/workspace',
      '@poietica/automation',
      '@poietica/settings',
    ],
  },
  { name: 'integration', members: ['@poietica/native-bridge'] },
  { name: 'composition', members: ['@poietica/desktop'] },
]

export const CARGO_RINGS: readonly Ring[] = [
  { name: 'vocabulary', members: ['poietica-problem', 'poietica-time'] },
  {
    name: 'domain',
    members: ['poietica-automation', 'poietica-conversation', 'poietica-review-native'],
  },
  {
    name: 'capability',
    members: [
      'poietica-library',
      'poietica-asset',
      'poietica-browser-native',
      'poietica-extension-native',
      'poietica-git-adapter-native',
      'poietica-kap-client',
      'poietica-ledger',
      'poietica-process-host',
      'poietica-terminal-native',
    ],
  },
  { name: 'conversation-execution', members: ['poietica-conversation-runtime'] },
  { name: 'automation-execution', members: ['poietica-automation-runtime'] },
  { name: 'composition', members: ['poietica'] },
]

export const UNLAYERED_DIRECTORIES: readonly string[] = ['tests', 'tools']
export const HOST_AWARE_PACKAGES: readonly string[] = [
  '@poietica/contract',
  '@poietica/native-bridge',
]
export const HOST_AGNOSTIC_CRATES: readonly string[] = [
  'poietica-library',
  'poietica-automation-runtime',
  'poietica-conversation-runtime',
  'poietica-browser-native',
  'poietica-asset',
  'poietica-automation',
  'poietica-conversation',
  'poietica-extension-native',
  'poietica-git-adapter-native',
  'poietica-kap-client',
  'poietica-ledger',
  'poietica-problem',
  'poietica-process-host',
  'poietica-review-native',
  'poietica-terminal-native',
  'poietica-time',
]
export const FRAMEWORK_FREE_PACKAGES: readonly string[] = [
  '@poietica/library',
  '@poietica/contract',
  '@poietica/problem',
  '@poietica/external-store',
  '@poietica/agent-catalog',
  '@poietica/update',
]

export const FRAMEWORK_SPECIFIERS: readonly string[] = ['react', 'react-dom', 'react/jsx-runtime']
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

export const DOMAIN_CONTRACT_IMPORTS: Readonly<Record<string, string>> = {
  '@poietica/library': '@poietica/contract/library',
  '@poietica/automation': '@poietica/contract/automation',
  '@poietica/browser': '@poietica/contract/browser',
  '@poietica/conversation': '@poietica/contract/conversation',
  '@poietica/review': '@poietica/contract/review',
  '@poietica/settings': '@poietica/contract/settings',
}

const PEER_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  '@poietica/conversation': ['@poietica/review'],
  '@poietica/workspace': ['@poietica/browser'],
  '@poietica/automation': ['@poietica/conversation'],
  '@poietica/settings': ['@poietica/conversation', '@poietica/extension'],
}
export function typeScriptDependencyAllowed(from: string, to: string): boolean {
  const source = ringOf(TYPESCRIPT_RINGS, from)
  const target = ringOf(TYPESCRIPT_RINGS, to)
  if (source < 0 || target < 0) {
    return false
  }
  if (target < source) {
    return true
  }
  return source === target && (PEER_DEPENDENCIES[from]?.includes(to) ?? false)
}
