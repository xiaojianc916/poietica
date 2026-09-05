import type { AppUpdateController } from '@poietica/update'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

export function createAppUpdateController(): AppUpdateController {
  let selected: Update | null = null

  const release = async (): Promise<void> => {
    const owned = selected
    selected = null
    if (owned !== null) {
      await owned.close()
    }
  }

  return {
    async check() {
      await release()
      selected = await check()
      return selected === null ? null : { version: selected.version, notes: selected.body ?? null }
    },

    async download(version, onProgress) {
      if (selected === null || selected.version !== version) {
        throw new Error('the selected update is no longer available')
      }
      let received = 0
      let total: number | null = null
      const progress = (event: DownloadEvent): void => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null
          onProgress({ percent: null })
          return
        }
        if (event.event === 'Progress') {
          received += event.data.chunkLength
          onProgress({
            percent:
              total === null || total === 0
                ? null
                : Math.min(100, Math.floor((received / total) * 100)),
          })
          return
        }
        onProgress({ percent: 100 })
      }
      await selected.download(progress)
    },

    async relaunch() {
      if (selected === null) {
        throw new Error('no downloaded update is available')
      }
      const owned = selected
      selected = null
      try {
        await owned.install({ restartAfterInstall: true })
      } finally {
        await owned.close().catch(() => undefined)
      }
    },

    dispose: release,
  }
}
