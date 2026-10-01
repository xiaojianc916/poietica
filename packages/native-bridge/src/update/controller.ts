import type { AppUpdateController } from '@poietica/update'
import { hostBridge } from '../host-bridge'

/*
 * 出货更新。包在 electron-updater 上，而那是主进程的能力，所以这里只经 window.poietica
 * 调四条宿主命令 —— 渲染层拿不到 fs，也不该拿。
 *
 * 下载进度没有通道：宿主报开始与结束两次，中间一律 percent: null。percent 为 null 是
 * update 端口本来就认的形状（进度未知），编一个数字才是错的。
 */

interface UpdateCheck {
  readonly version: string
  readonly notes: string | null
}

export function createAppUpdateController(): AppUpdateController {
  let selected: string | null = null

  const invoke = <T>(command: string, args: unknown = null): Promise<T> =>
    hostBridge().invoke(command, args) as Promise<T>

  return {
    async check() {
      selected = null
      const found = await invoke<UpdateCheck | null>('update_check')

      if (found === null) {
        return null
      }

      selected = found.version

      return { version: found.version, notes: found.notes }
    },

    async download(version, onProgress) {
      if (selected !== version) {
        throw new Error('选中的更新已经不在手上了')
      }

      onProgress({ percent: null })
      await invoke('update_download', { version })
      onProgress({ percent: 100 })
    },

    async relaunch() {
      if (selected === null) {
        throw new Error('没有已下载的更新可安装')
      }

      selected = null
      await invoke('update_relaunch')
    },

    async dispose() {
      selected = null
    },
  }
}
