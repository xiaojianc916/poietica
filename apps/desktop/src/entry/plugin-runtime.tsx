import type { PluginStore } from '@poietica/extension'
import { useEffect } from 'react'

/*
 * 插件运行时装载点。「到期时启动、停应用时回首扫」挂在应用这一侧的 effect 上，
 * store 本身由组合根构造注入（见 entry/compose-runtime.ts），这里不另立单例。
 */
export function PluginLoader({ store }: { store: PluginStore }) {
  useEffect(() => {
    void store.start()

    /* 谁 start 谁 stop：下一次装载重新首扫。 */
    return () => {
      store.stop()
    }
  }, [store])

  return null
}
