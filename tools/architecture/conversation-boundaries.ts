import path from 'node:path'
import type { Violation } from './policies.ts'

const dependencies: Readonly<Record<string, readonly string[]>> = {
  agent: ['agent'],
  composer: ['agent', 'composer'],
  configuration: ['agent', 'configuration', 'transcript-input', 'failure'],
  interjection: ['agent', 'interjection'],
  threads: ['agent', 'threads', 'failure'],
  timeline: ['agent', 'timeline'],
  'transcript-input': ['agent'],
  transcript: ['agent', 'interjection', 'timeline', 'transcript', 'transcript-input', 'failure'],
  failure: ['failure'],
  runtime: [
    'agent',
    'composer',
    'configuration',
    'threads',
    'timeline',
    'transcript',
    'transcript-input',
    'interjection',
    'failure',
  ],
  entry: [
    'agent',
    'composer',
    'configuration',
    'threads',
    'timeline',
    'transcript',
    'transcript-input',
    'interjection',
    'failure',
    'runtime',
  ],
  surface: [
    'agent',
    'composer',
    'configuration',
    'threads',
    'timeline',
    'transcript',
    'transcript-input',
    'interjection',
    'failure',
    'surface',
  ],
}

function responsibility(root: string, file: string): string | undefined {
  const directory = path.join(root, 'packages', 'conversation', 'src')
  const local = path.relative(directory, file).split(path.sep).join('/')
  if (local === '..' || local.startsWith('../') || path.isAbsolute(local)) {
    return undefined
  }
  if (local === 'index.ts') {
    return 'entry'
  }
  if (local === 'runtime.ts') {
    return 'runtime'
  }
  if (local === 'failure.ts') {
    return 'failure'
  }
  if (local === 'transcript/transcript-sink.ts') {
    return 'transcript-input'
  }
  return local.split('/')[0] ?? ''
}

export function conversationCore(root: string, file: string): boolean {
  const kind = responsibility(root, file)
  return kind !== undefined && kind !== 'surface' && dependencies[kind] !== undefined
}

export function conversationBoundaries(
  root: string,
  file: string,
  target: string,
  typeOnly: boolean,
): Violation[] {
  const from = responsibility(root, file)
  if (from === undefined) {
    return []
  }
  const reject = (detail: string): Violation[] => [
    {
      policy: 'conversation-responsibility-direction',
      where: path.relative(root, file).split(path.sep).join('/'),
      detail,
    },
  ]
  const allowed = dependencies[from]
  if (allowed === undefined) {
    return reject(`Unclassified conversation responsibility: ${from}`)
  }
  if (from !== 'surface' && file.endsWith('.tsx')) {
    return reject('JSX modules belong to the surface boundary.')
  }
  const to = responsibility(root, target)
  if (to === undefined || file === target) {
    return []
  }
  if (from === 'surface' && to === 'runtime' && typeOnly) {
    return []
  }
  if (!allowed.includes(to)) {
    return reject(`${from} cannot depend on ${to}: ${path.relative(root, target)}`)
  }
  if (to === 'transcript-input' && !typeOnly) {
    return reject('Transcript handoff is a type-only capability, not a second state owner.')
  }
  return []
}
