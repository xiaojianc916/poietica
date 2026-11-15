import { policyContract } from '@poietica/feature-policy/contract'
import { builtinPoints, defineUiFeature, SETTINGS_GROUPS } from '@poietica/ui-kernel'
import { ShieldCheck } from 'lucide-react'
import { PolicyGrantsPage } from './grants-page'

/** 授权管理页：读 policy.grants.list、撤销 policy.grants.revoke；值仍由 policy 的持久表持有。 */
export default defineUiFeature({
  id: 'policy',
  setup(ctx) {
    const policy = ctx.rpc(policyContract)
    ctx.contribute(builtinPoints.settingsPages, {
      id: 'policy.grants',
      group: SETTINGS_GROUPS.system,
      order: 650,
      title: '授权管理',
      icon: ShieldCheck,
      component: () => <PolicyGrantsPage policy={policy} />,
    })
  },
})
