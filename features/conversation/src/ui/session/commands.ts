import type { SlashCommand } from '@poietica/engine'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConversationApi } from '../api'
import type { ThreadCommands } from '../shared/model/commands'

const NO_COMMANDS: readonly SlashCommand[] = Object.freeze([])

/**
 * 一条对话的斜杠命令：挂载读一次表，`commands.changed` 再读；输出按 threadId 收。
 * 没有对话号（入口页）时整面是空的 —— 命令要一条活会话才有意义。
 */
export function useThreadCommands(api: ConversationApi, threadId: string): ThreadCommands {
  const [list, setList] = useState<readonly SlashCommand[]>(NO_COMMANDS)
  const [output, setOutput] = useState<ThreadCommands['output']>(null)

  useEffect(() => {
    if (threadId === '') return
    let live = true
    const load = (): void => {
      void api.listCommands(threadId).then(
        (commands) => {
          if (live) setList(commands)
        },
        /* 读不到表（会话起不来）就是没有命令可选；起不来的原因由控件那一条横幅说 */
        () => undefined,
      )
    }
    load()
    const offChanged = api.onCommandsChanged((p) => {
      if (p.threadId === threadId) load()
    })
    const offOutput = api.onCommandOutput((p) => {
      if (p.threadId !== threadId) return
      setOutput((held) =>
        held === null ? { command: '', lines: [p.text] } : { ...held, lines: [...held.lines, p.text] },
      )
    })
    return () => {
      live = false
      offChanged.dispose()
      offOutput.dispose()
    }
  }, [api, threadId])

  const run = useCallback(
    async (text: string) => {
      const command = text.trim()
      /* 新命令换一块输出：上一条的输出到这里就算看过了 */
      setOutput({ command, lines: [] })
      try {
        await api.runCommand(threadId, command)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setOutput({ command, lines: [message] })
      }
    },
    [api, threadId],
  )

  const dismissOutput = useCallback(() => setOutput(null), [])

  return useMemo(() => ({ list, output, run, dismissOutput }), [list, output, run, dismissOutput])
}
