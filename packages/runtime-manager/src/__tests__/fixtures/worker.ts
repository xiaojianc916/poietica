import { existsSync, rmSync } from 'node:fs'
import { createStdioTransport } from '@poietica/rpc/stdio'
import { createRuntimeKernel } from '@poietica/runtime-kernel'
import { createTestLogger } from '@poietica/test-kit'

createRuntimeKernel({
  transport: createStdioTransport({
    input: process.stdin,
    writeFrame: (frame) => process.stdout.write(frame),
    onStray: () => undefined,
  }),
  logger: createTestLogger(),
  info: { runtimeVersion: 'test', engineVersion: 'fake' },
  handlers: { 'session.ping': () => ({ ok: true }) },
})

if (process.env.RUNTIME_FIXTURE_EXIT_MS !== undefined) {
  setTimeout(() => process.exit(7), Number(process.env.RUNTIME_FIXTURE_EXIT_MS))
}

const exitOnce = process.env.RUNTIME_FIXTURE_EXIT_ONCE
if (exitOnce !== undefined && existsSync(exitOnce)) {
  rmSync(exitOnce, { force: true })
  setTimeout(() => process.exit(8), 100)
}

const hang = Number(process.env.RUNTIME_FIXTURE_HANG_MS ?? '0')
if (hang > 0) {
  setTimeout(() => {
    const end = Date.now() + hang
    while (Date.now() < end) {
      /* 卡住事件循环，让心跳收不到回复 */
    }
  }, 200)
}
