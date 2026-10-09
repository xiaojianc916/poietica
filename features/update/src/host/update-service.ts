import { AppError, type Clock, Emitter, type Logger } from '@poietica/foundation'
import type { UpdateState } from '../contract/entities'
import { updateErrors } from '../contract/errors'

export interface UpdaterPort {
  /** 没有新版本时返回 isUpdateAvailable:false（electron-updater 的真实行为） */
  checkForUpdates(): Promise<{
    isUpdateAvailable: boolean
    updateInfo: { version: string; releaseNotes?: unknown }
  } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  onDownloadProgress(handler: (percent: number) => void): () => void
}

/**
 * 发布说明转纯文本（07 页 §15D）：两种形状（字符串 / 逐版本数组）都接，
 * `<br>` 与块级标签的收尾换行、其余标签剥掉，UI 不渲染 HTML。
 */
export function notesToText(notes: unknown): string | null {
  const raw =
    typeof notes === 'string'
      ? notes
      : Array.isArray(notes)
        ? notes
            .map((n) =>
              typeof n === 'object' && n !== null && 'note' in n ? String((n as { note: unknown }).note ?? '') : '',
            )
            .join('\n')
        : ''
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > 0 ? text : null
}

/** 错误文案取自契约（defineErrors 的 __messages），与 UI 兜底一字不差。 */
const messageOf = (code: string): string => updateErrors.__messages[code] ?? code

/**
 * 更新状态机（07 页 §15D 完整代码）。
 *
 * 不 import electron / electron-updater：更新器由 `updater` 注入（打包版由 host/index.ts
 * 装配真身，开发版同样装配 —— 读 dev-app-update.yml），所以全部相位转换都能单测
 * （UP-1…UP-7）。`null` 仍是合法输入：装配不出来时状态机退回 `disabled`。
 */
export function createUpdateService(d: {
  /** 缺席时相位停在 disabled（正常装配两条路径都会给真身） */
  updater: UpdaterPort | null
  currentVersion: string
  logger: Logger
  clock: Clock
  quit: (finalize: () => void) => Promise<void>
}) {
  const changed = new Emitter<UpdateState>()
  let state: UpdateState = {
    phase: d.updater === null ? 'disabled' : 'idle',
    currentVersion: d.currentVersion,
    version: null,
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  }
  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    changed.fire(state)
  }
  const need = (): UpdaterPort => {
    if (d.updater === null) throw new AppError(updateErrors.disabled, messageOf(updateErrors.disabled))
    return d.updater
  }

  return {
    state: () => state,
    onChange: changed.event,
    async check(): Promise<UpdateState> {
      const u = need()
      if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready') {
        return state
      }
      set({ phase: 'checking', error: null })
      try {
        const r = await u.checkForUpdates()
        const now = d.clock.now()
        if (r === null || !r.isUpdateAvailable) {
          set({ phase: 'idle', version: null, notes: null, lastCheckedAt: now })
        } else {
          set({
            phase: 'available',
            version: r.updateInfo.version,
            notes: notesToText(r.updateInfo.releaseNotes),
            lastCheckedAt: now,
          })
        }
      } catch (e) {
        d.logger.warn('update check failed', { error: String(e) })
        set({ phase: 'error', error: '检查更新失败，请稍后重试' })
      }
      return state
    },
    async download(): Promise<UpdateState> {
      const u = need()
      if (state.phase !== 'available')
        throw new AppError(updateErrors.invalid_phase, messageOf(updateErrors.invalid_phase))
      set({ phase: 'downloading', progress: 0 })
      const off = u.onDownloadProgress((percent) => set({ progress: Math.max(0, Math.min(1, percent / 100)) }))
      try {
        await u.downloadUpdate()
        set({ phase: 'ready', progress: 1 })
      } catch (e) {
        d.logger.warn('update download failed', { error: String(e) })
        set({ phase: 'error', progress: null, error: '下载更新失败，请稍后重试' })
      } finally {
        off()
      }
      return state
    },
    async install(): Promise<UpdateState> {
      const u = need()
      if (state.phase !== 'ready') throw new AppError(updateErrors.invalid_phase, messageOf(updateErrors.invalid_phase))
      d.logger.info('installing update', { version: state.version })
      await d.quit(() => {
        u.quitAndInstall()
      })
      return state
    },
  }
}

export type UpdateService = ReturnType<typeof createUpdateService>
