import type { Plugin } from 'vite'

const FORBIDDEN_INITIAL_MODULES = [
  '/node_modules/@streamdown/',
  '/node_modules/@xterm/',
  '/node_modules/katex/',
  '/node_modules/shiki/',
  '/node_modules/streamdown/',
  '/node_modules/yet-another-react-lightbox/',
]

type ChunkLike = {
  readonly type: 'chunk'
  readonly imports: readonly string[]
  readonly code: string
  readonly modules: Record<string, unknown>
  readonly isEntry: boolean
}

function collectChunks(bundle: Record<string, { readonly type: string }>): Map<string, ChunkLike> {
  const chunks = new Map<string, ChunkLike>()
  for (const [fileName, output] of Object.entries(bundle)) {
    if (output.type === 'chunk') {
      chunks.set(fileName, output as ChunkLike)
    }
  }
  return chunks
}

function collectInitial(chunks: ReadonlyMap<string, ChunkLike>): {
  initial: Set<string>
  missing: string | undefined
} {
  const initial = new Set<string>()
  const stack: string[] = []
  for (const [fileName, chunk] of chunks) {
    if (chunk.isEntry) {
      stack.push(fileName)
    }
  }
  let missing: string | undefined
  while (stack.length > 0) {
    const fileName = stack.pop() as string
    if (initial.has(fileName)) {
      continue
    }
    const chunk = chunks.get(fileName)
    if (chunk === undefined) {
      missing = fileName
      return { initial, missing }
    }
    initial.add(fileName)
    for (const imported of chunk.imports) {
      stack.push(imported)
    }
  }
  return { initial, missing }
}

function measureStartup(
  chunks: ReadonlyMap<string, ChunkLike>,
  initial: ReadonlySet<string>,
): { bytes: number; offenders: Set<string> } {
  let bytes = 0
  const offenders = new Set<string>()
  for (const fileName of initial) {
    const chunk = chunks.get(fileName)
    if (chunk === undefined) {
      continue
    }
    bytes += Buffer.byteLength(chunk.code)
    for (const moduleId of Object.keys(chunk.modules)) {
      const normalized = moduleId.replaceAll('\\', '/')
      if (FORBIDDEN_INITIAL_MODULES.some((fragment) => normalized.includes(fragment))) {
        offenders.add(normalized)
      }
    }
  }
  return { bytes, offenders }
}

export function startupBoundaryPlugin(): Plugin {
  return {
    name: 'poietica-startup-boundary',
    generateBundle(_options, bundle) {
      const chunks = collectChunks(bundle)
      const { initial, missing } = collectInitial(chunks)
      if (missing !== undefined) {
        this.error(`missing static chunk: ${missing}`)
      }
      const { bytes, offenders } = measureStartup(chunks, initial)
      if (offenders.size > 0) {
        this.error(
          ['heavy modules crossed the startup boundary:', ...[...offenders].sort()].join('\n'),
        )
      }
      this.info(`startup static JavaScript: ${bytes} bytes across ${initial.size} chunks`)
    },
  }
}
