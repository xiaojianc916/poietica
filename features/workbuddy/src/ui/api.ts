import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type { WorkBuddyCheckin, WorkBuddyLoginEvent, WorkBuddySnapshot } from '../contract'
import { workbuddyContract } from '../contract'

export function createWorkBuddyApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof workbuddyContract> = ctx.rpc(workbuddyContract)
  return {
    snapshot: (): Promise<WorkBuddySnapshot> => rpc.call('workbuddy.snapshot', {}),
    startBrowserLogin: (accountId: string | null) => rpc.call('workbuddy.startBrowserLogin', { accountId }),
    cancelLogin: (loginId: string) => rpc.call('workbuddy.cancelLogin', { loginId }).then(() => undefined),
    addApiKey: (apiKey: string) => rpc.call('workbuddy.addApiKey', { apiKey }),
    removeAccount: (accountId: string) => rpc.call('workbuddy.removeAccount', { accountId }).then(() => undefined),
    setPreferred: (accountId: string) => rpc.call('workbuddy.setPreferred', { accountId }).then(() => undefined),
    refreshUsage: (accountId: string | null) => rpc.call('workbuddy.refreshUsage', { accountId }),
    checkin: (accountId: string): Promise<WorkBuddyCheckin> => rpc.call('workbuddy.checkin', { accountId }),
    setEnabled: (enabled: boolean) => rpc.call('workbuddy.setEnabled', { enabled }),
    setAutoCheckin: (enabled: boolean) => rpc.call('workbuddy.setAutoCheckin', { enabled }),
    repairProvider: () => rpc.call('workbuddy.repairProvider', {}),
    onChanged: (listener: () => void) => rpc.on('workbuddy.changed', listener),
    onLoginEvent: (listener: (event: WorkBuddyLoginEvent) => void) => rpc.on('workbuddy.loginEvent', listener),
  }
}

export type WorkBuddyApi = ReturnType<typeof createWorkBuddyApi>
