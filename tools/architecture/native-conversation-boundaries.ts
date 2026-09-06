import path from 'node:path'
import type { Violation } from './policies.ts'

const PREFIX = 'packages/native-bridge/src/conversation/'
const EDGES: Readonly<Record<string, readonly string[]>> = {
  'index.ts': [
    'launch-contract.ts',
    'event-subscription.ts',
    'session.ts',
    'configuration.ts',
    'threads.ts',
    'toolkit.ts',
  ],
  'session.ts': ['launch-contract.ts', 'event-subscription.ts', 'transcript-decoding.ts'],
  'configuration.ts': ['launch-contract.ts', 'event-subscription.ts', 'selectors.ts', 'toolkit.ts'],
  'threads.ts': ['launch-contract.ts', 'selectors.ts', 'transcript-decoding.ts'],
  'toolkit.ts': ['launch-contract.ts'],
  'launch-contract.ts': [],
  'event-subscription.ts': [],
  'selectors.ts': [],
  'transcript-decoding.ts': [],
}

export function nativeConversationBoundaries(
  root: string,
  file: string,
  target: string,
): Violation[] {
  const source = path.relative(root, file).split(path.sep).join('/')
  const destination = path.relative(root, target).split(path.sep).join('/')
  if (!source.startsWith(PREFIX)) {
    return []
  }
  const reject = (detail: string): Violation[] => [
    { policy: 'native-conversation-direction', where: source, detail },
  ]
  const member = source.slice(PREFIX.length)
  if (!Object.hasOwn(EDGES, member)) {
    return reject('Assign each native conversation file a responsibility and dependency direction.')
  }
  if (!destination.startsWith(PREFIX)) {
    return destination.startsWith('packages/native-bridge/src/') &&
      destination !== 'packages/native-bridge/src/ipc-error.ts'
      ? reject(
          'Conversation ports may use the shared IPC boundary, not unrelated host integrations.',
        )
      : []
  }
  const dependency = destination.slice(PREFIX.length)
  return source === destination || EDGES[member]?.includes(dependency)
    ? []
    : reject([member, 'must not depend on', dependency].join(' '))
}
