import type { Plugin } from 'vite'

const FORBIDDEN_INITIAL_MODULES = [
  '/node_modules/@streamdown/',
  '/node_modules/@xterm/',
  '/node_modules/katex/',
  '/node_modules/shiki/',
  '/node_modules/streamdown/',
  '/node_modules/yet-another-react-lightbox/',
]

export function startupBoundaryPlugin(): Plugin {
  return {
    name: 'poietica-startup-boundary',
    generateBundle(_options, bundle) {
      type BundleItem = (typeof bundle)[string]
      type Chunk = Extract<BundleItem, { type: 'chunk' }>
      const chunks = new Map<string, Chunk>()
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          chunks.set(fileName, output)
        }
      }

      const initial = new Set<string>()
      const visit = (fileName: string): void => {
        if (initial.has(fileName)) {
          return
        }
        const chunk = chunks.get(fileName)
        if (chunk === undefined) {
          this.error(`missing static chunk: ${fileName}`)
        }
        initial.add(fileName)
        for (const imported of chunk.imports) {
          visit(imported)
        }
      }
      for (const [fileName, chunk] of chunks) {
        if (chunk.isEntry) {
          visit(fileName)
        }
      }

      const offenders = new Set<string>()
      let bytes = 0
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

      if (offenders.size > 0) {
        this.error(
          ['heavy modules crossed the startup boundary:', ...[...offenders].sort()].join('\n'),
        )
      }
      this.info(`startup static JavaScript: ${bytes} bytes across ${initial.size} chunks`)
    },
  }
}
