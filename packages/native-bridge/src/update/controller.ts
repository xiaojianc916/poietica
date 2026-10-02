import type { AppUpdateController } from '@poietica/update'
import { hostBridge } from '../host-bridge'

/*
 * 出货更新。包在 electron-updater 上，而那是主进程的能力，所以这里只经 window.poietica
 * 调三条宿主命令 —— 渲染层拿不到 fs，也不该拿。
 *
 * 进度是宿主推过来的事件（`update-progress`）：主进程订阅 electron-updater 的
 * download-progress，按 percent 校验后转发。这里只订阅与退订，不编数字 ——
 * 下载中那条横幅要的是真实的百分比，报不出来的那些时刻就该是 null。
 */

interface UpdateCheck {
  readonly version: string
  readonly notes: string | null
}

/** 进度事件的载荷；形状由 apps/desktop/electron/update.ts 的 progressOf 定。 */
interface UpdateProgressPayload {
  readonly percent: number
}

function isProgressPayload(payload: unknown): payload is UpdateProgressPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false
  }

  const percent = (payload as Record<string, unknown>)['percent']

  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
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

      /*
       * 先订阅再下令：update_download 是个长往返，等它回来才订阅就丢掉开头那几帧。
       * 订阅只活在这一段下载里，下一次下载不会多一个听众。
       */
      const stop = hostBridge().on('update-progress', (payload) => {
        if (isProgressPayload(payload)) {
          onProgress({ percent: payload.percent })
        }
      })

      try {
        await invoke('update_download', { version })
      } finally {
        stop()
      }
    },

    async relaunch() {
      if (selected === null) {
        throw new Error('没有已下载的更新可安装')
      }

      selected = null
      await invoke('update_relaunch')
    },

    async dispose(): Promise<void> {
      // 端口契约要求 Promise；这里没有异步动作，但接口是它定的。
      await Promise.resolve()
      selected = null
    },
  }
}
