import type { ServiceToken } from '@poietica/foundation'
import { useMemo, useSyncExternalStore } from 'react'
import type { Contributed, ContributionPoint } from '../contribution'
import type { Observable } from '../services/observable'
import { useFeatureId, useKernel } from './kernel-context'

/** 组件里取服务：与 setup 中的 ctx.services.get 遵守同样的 dependsOn 规则 */
export function useService<T>(token: ServiceToken<T>): T {
  const kernel = useKernel()
  const featureId = useFeatureId()
  return useMemo(() => kernel.servicesFor(featureId).get(token), [kernel, featureId, token])
}

export function useObservable<T>(o: Observable<T>): T {
  return useSyncExternalStore(o.subscribe, o.current)
}

export const useCoreStatus = () => useObservable(useKernel().kernelServices.coreStatus)
export const useNavigation = () => useObservable(useKernel().kernelServices.navigation)
export const useLayout = () => useObservable(useKernel().kernelServices.layout)
/**
 * 订阅一个贡献点。放在 react/ 而不是 contribution.ts：后者若 import 本文件，
 * 会形成 contribution → react/kernel-context → kernel → contribution 的环
 * （depcruise 的 no-circular 规则不允许）。
 */
export function useContributions<T>(point: ContributionPoint<T>): readonly Contributed<T>[] {
  const { registry } = useKernel()
  return useSyncExternalStore(
    (cb) => registry.subscribe(point as ContributionPoint<unknown>, cb),
    () => registry.list(point),
  )
}
