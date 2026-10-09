import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type { PythonStatus } from '../contract'
import { pythonContract } from '../contract'

export function createPythonApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof pythonContract> = ctx.rpc(pythonContract)
  return {
    status: (): Promise<PythonStatus> => rpc.call('python.status', {}),
    install: (): Promise<PythonStatus> => rpc.call('python.install', {}),
    remove: (): Promise<void> => rpc.call('python.remove', {}).then(() => undefined),
    onStatusChanged: (listener: (status: PythonStatus) => void) => rpc.on('python.statusChanged', listener),
  }
}

export type PythonApi = ReturnType<typeof createPythonApi>
