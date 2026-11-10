import { createStdioTransport } from '@poietica/rpc/stdio'
import { createRuntimeKernel } from '@poietica/runtime-kernel'
import type { ArpEventParams } from '@poietica/runtime-protocol'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { createTestLogger } from '@poietica/test-kit'
import { createArpHandlers } from '../../handlers'

const engine = createFakeEngine()
engine.freezeTools()
const logger = createTestLogger()
let kernel: ReturnType<typeof createRuntimeKernel>
const arp = createArpHandlers({ engine, emit: (p: ArpEventParams) => kernel.peer.notify('runtime.event', p) })
kernel = createRuntimeKernel({
  transport: createStdioTransport({
    input: process.stdin,
    writeFrame: (frame) => process.stdout.write(frame),
    onStray: () => undefined,
  }),
  logger,
  info: { runtimeVersion: 'test', engineVersion: 'fake' },
  handlers: arp.handlers,
})
