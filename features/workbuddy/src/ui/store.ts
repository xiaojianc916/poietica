import { createFeatureStore } from '@poietica/ui-kernel'

/** Core 每次进入 ready 都加一，设置页据此重读一次；通知是有损的，重启后只能靠重读。 */
export const coreGeneration = createFeatureStore<{ readonly value: number }>(() => ({ value: 0 }))

export function noteCoreReady(): void {
  coreGeneration.setState((state) => ({ value: state.value + 1 }))
}
