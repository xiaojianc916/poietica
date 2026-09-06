import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'packages/contract/src/generated/ipc-bindings.ts')
const expected = readFileSync(output)
let failure: unknown
try {
  const generated = spawnSync('bun', ['tools/contract/generate-ipc.ts'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (generated.error || generated.status !== 0) {
    throw generated.error ?? new Error('IPC generation failed.')
  }
  if (!expected.equals(readFileSync(output))) {
    throw new Error(
      'IPC bindings differ from the authoritative generator. Run bun run ipc:generate.',
    )
  }
} catch (cause) {
  failure = cause
} finally {
  writeFileSync(output, expected)
}
if (failure !== undefined) {
  console.error('ipc check:', failure)
  process.exitCode = 1
}
