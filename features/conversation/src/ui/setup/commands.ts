import { builtinPoints, type CommandItem } from '@poietica/ui-kernel'
import { confirmDeleteThread } from '../session'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

export function createConversationCommands(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, dialogs, prefs, stores, banners } = setup
  const { activeThreadId, exportThread, newThread, openThread } = actions

  /* 停在入口页时重命名 / 删除 / 分支 / 导出都没有落点：enabled 报假，命令面板与快捷键都不给点。 */
  const hasThread = (): boolean => activeThreadId() !== null
  const running = (): boolean => {
    const current = activeThreadId()
    return current !== null && stores.turnStates.isRunning(current)
  }
  const command = (id: string, title: string, run: () => void, enabled?: () => boolean): void => {
    ctx.contribute(builtinPoints.commands, {
      id,
      title,
      category: '对话',
      run,
      ...(enabled === undefined ? {} : { enabled }),
    } satisfies CommandItem)
  }
  command('conversation.newThread', '新建对话', () => newThread())
  command('conversation.focusComposer', '聚焦输入框', () => {
    document.querySelector<HTMLElement>('[data-slot="prompt-input"]')?.focus()
  })
  command(
    'conversation.cancelTurn',
    '停止运行',
    () => {
      const current = activeThreadId()
      if (current !== null) void api.cancelTurn(current)
    },
    running,
  )
  command(
    'conversation.renameThread',
    '重命名对话',
    () => {
      const current = activeThreadId()
      if (current === null) return
      const thread = stores.threads.byId(current)
      if (thread === undefined) return
      const next = window.prompt('重命名对话', thread.title)
      if (next === null) return
      void api.renameThread(current, next).then((t) => stores.threads.upsert(t))
    },
    hasThread,
  )
  command(
    'conversation.deleteThread',
    '删除对话',
    () => {
      const current = activeThreadId()
      const thread = current === null ? undefined : stores.threads.byId(current)
      if (thread === undefined) return
      void confirmDeleteThread(dialogs, prefs.current().general.confirmBeforeDelete, thread).then((ok) => {
        if (!ok) return
        /* 失败要看得见、查得到：原先 `void` 一丢，删不掉时既没有提示也没有日志 */
        void api.deleteThread(thread.id).catch((cause: unknown) => {
          ctx.logger.warn('thread delete failed', { threadId: thread.id, error: String(cause) })
          banners.error(cause)
        })
      })
    },
    hasThread,
  )
  command(
    'conversation.forkThread',
    '分支对话',
    () => {
      const threadId = activeThreadId()
      if (threadId === null) return
      /* 斜杠命令 `/fork` 也走这一条：失败要报出来，不能静默（输入框里敲了命令却什么都没发生）。 */
      void api.forkThread({ threadId }).then(
        (t) => {
          stores.threads.upsert(t)
          openThread(t.id)
        },
        (cause: unknown) => {
          banners.error(cause, '分支对话失败')
        },
      )
    },
    hasThread,
  )
  command(
    'conversation.exportThread',
    '导出对话为 Markdown',
    () => {
      const current = activeThreadId()
      if (current !== null) void exportThread(current)
    },
    hasThread,
  )

  const bind = (command_: string, key: string, when?: () => boolean): void => {
    ctx.contribute(builtinPoints.keybindings, {
      command: command_,
      key,
      ...(when === undefined ? {} : { when }),
    })
  }
  bind('conversation.newThread', 'Ctrl+N')
  bind('conversation.focusComposer', 'Ctrl+L')
  bind('conversation.cancelTurn', 'Escape', running)
}
