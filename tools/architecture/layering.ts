/**
 * 环序即依赖方向：只允许高环指向低环，同环不连边。
 * 产品包按 bounded context 纵切；只有 FRAMEWORK_FREE_PACKAGES 保证无 UI。
 */
export type Ring = { readonly name: string; readonly members: readonly string[] }

export const TYPESCRIPT_RINGS: readonly Ring[] = [
  { name: 'contract', members: ['@poietica/contract'] },
  { name: 'vocabulary', members: ['@poietica/problem', '@poietica/external-store'] },
  { name: 'design-system', members: ['@poietica/design-system'] },
  { name: 'agent-profiles', members: ['@poietica/agent-catalog'] },
  {
    name: 'core-domain',
    members: [
      '@poietica/conversation',
      '@poietica/extension',
      '@poietica/update',
      '@poietica/workspace',
    ],
  },
  { name: 'composer', members: ['@poietica/composer'] },
  {
    name: 'vertical-feature',
    members: ['@poietica/automation', '@poietica/settings', '@poietica/auxiliary'],
  },
  { name: 'adapter', members: ['@poietica/native-bridge'] },
  { name: 'assistant', members: ['@poietica/assistant'] },
  { name: 'composition', members: ['@poietica/desktop'] },
]

export const CARGO_RINGS: readonly Ring[] = [
  { name: 'vocabulary', members: ['poietica-problem', 'poietica-time'] },
  {
    name: 'domain',
    members: ['poietica-asset', 'poietica-conversation', 'poietica-review-native'],
  },
  {
    name: 'capability',
    members: [
      'poietica-browser-native',
      'poietica-extension-native',
      'poietica-git-adapter-native',
      'poietica-kap-client',
      'poietica-ledger',
      'poietica-process-host',
      'poietica-terminal-native',
      'poietica-update-native',
    ],
  },
  { name: 'composition', members: ['poietica'] },
]

export const UNLAYERED_DIRECTORIES: readonly string[] = ['tests', 'tools']
export const HOST_AWARE_PACKAGES: readonly string[] = [
  '@poietica/contract',
  '@poietica/native-bridge',
]
export const HOST_AGNOSTIC_CRATES: readonly string[] = [
  'poietica-browser-native',
  'poietica-asset',
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
  'poietica-update-native',
]
export const FRAMEWORK_FREE_PACKAGES: readonly string[] = [
  '@poietica/contract',
  '@poietica/problem',
  '@poietica/external-store',
  '@poietica/agent-catalog',
  '@poietica/conversation',
  '@poietica/update',
  '@poietica/workspace',
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
