import { platformContract } from '@poietica/feature-platform/contract'
import { builtinPoints, defineUiFeature, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { PlugZap } from 'lucide-react'
import { createWorkBuddyApi } from './api'
import { noteCoreReady } from './store'
import { WorkBuddyPage } from './workbuddy-page'

/* 设置里的「WorkBuddy」一页：账号、积分、签到、反代。页面只经本功能契约取数；
 * 打开授权页是系统能力，走 platform 的 shell.openExternal。 */
export default defineUiFeature({
  id: 'workbuddy',
  dependsOn: ['platform'],
  setup(ctx) {
    const api = createWorkBuddyApi(ctx)
    const platform = ctx.rpc(platformContract)

    ctx.lifecycle.onCoreReady(noteCoreReady)

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'workbuddy.accounts',
      group: SETTINGS_GROUPS.agent,
      order: 310,
      title: 'WorkBuddy',
      icon: PlugZap,
      component: () => (
        <WorkBuddyPage
          api={api}
          openUrl={async (url) => {
            await platform.call('shell.openExternal', { url })
          }}
        />
      ),
    })
  },
})
