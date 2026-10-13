import { builtinPoints, type CommandItem } from '@poietica/ui-kernel'
import { confirmDeleteThread } from '../session/notify'
import type { ConversationActions } from './actions'
import type { ConversationSetup } from './context'

export function createConversationCommands(setup: ConversationSetup, actions: ConversationActions): void {
  const { api, ctx, dialogs, prefs, stores } = setup
  const { activeThreadId, exportThread, newThread, openThread } = actions

  const command = (id: string, title: string, run: () => void): void => {
    ctx.contribute(builtinPoints.commands, { id, title, category: '对话', run } satisfies CommandItem)
  }
  command('conversation.newThread', '新建对话', () => newThread())
  command('conversation.focusComposer', '聚焦输入框', () => {
    document.querySelector<HTMLElement>('[data-slot="prompt-input"]')?.focus()
  })
  command('conversation.cancelTurn', '停止运行', () => {
    const current = activeThreadId()
    if (current !== null) void api.cancelTurn(current)
  })
  command('conversation.renameThread', '重命名对话', () => {
    const current = activeThreadId()
    if (current === null) return
    const thread = stores.threads.byId(current)
    if (thread === undefined) return
    const next = window.prompt('重命名对话', thread.title)
    if (next === null) return
    void api.renameThread(current, next).then((t) => stores.threads.upsert(t))
  })
  command('conversation.deleteThread', '删除对话', () => {
    const current = activeThreadId()
    const thread = current === null ? undefined : stores.threads.byId(current)
    if (thread === undefined) return
    void confirmDeleteThread(dialogs, prefs.current().general.confirmBeforeDelete, thread).then((ok) => {
      if (ok) void api.deleteThread(thread.id)
    })
  })
  command('conversation.forkThread', '分支对话', () => {
    const threadId = activeThreadId()
    if (threadId === null) return
    void api.forkThread({ threadId, undoTurns: 0 }).then((t) => {
      stores.threads.upsert(t)
      openThread(t.id)
    })
  })
  command('conversation.exportThread', '导出对话为 Markdown', () => {
    const current = activeThreadId()
    if (current !== null) void exportThread(current)
  })

  const bind = (command_: string, key: string, when?: () => boolean): void => {
    ctx.contribute(builtinPoints.keybindings, {
      command: command_,
      key,
      ...(when === undefined ? {} : { when }),
    })
  }
  bind('conversation.newThread', 'Ctrl+N')
  bind('conversation.focusComposer', 'Ctrl+L')
  bind('conversation.cancelTurn', 'Escape', () => {
    const current = activeThreadId()
    return current !== null && stores.turnStates.isRunning(current)
  })
}
