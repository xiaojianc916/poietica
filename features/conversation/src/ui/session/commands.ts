import type { SlashCommand } from '@poietica/engine'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationApi } from '../api'
import type { ThreadCommands } from '../shared/model/commands'

const NO_COMMANDS: readonly SlashCommand[] = Object.freeze([])

/**
 * 入口页的命令表：还没有对话，表按工作区现读（内置命令 + 该目录的文件命令，Core 的 commands.catalog）；换工作区重读。
 * 读不到（Core 没起来、工作区目录没了）就是没有命令可选，`/` 只是一个字 —— 起不来的原因由别处那条横幅说。
 */
export function useCommandCatalog(api: ConversationApi, workspaceId: string | null): readonly SlashCommand[] {
  const [list, setList] = useState<readonly SlashCommand[]>(NO_COMMANDS)

  useEffect(() => {
    let live = true
    void api.commandCatalog(workspaceId).then(
      (commands) => {
        if (live) setList(commands)
      },
      () => {
        if (live) setList(NO_COMMANDS)
      },
    )
    return () => {
      live = false
    }
  }, [api, workspaceId])

  return list
}

/**
 * 一条对话的斜杠命令：挂载读一次表，`commands.changed` 再读；输出按 threadId 收。
 * 没有对话号（入口页）时整面是空的 —— 入口页的表另由 useCommandCatalog 读。
 * `takePending`：入口页点了命令、刚建出这条对话就跳过来的那一句 —— 订阅好输出之后再执行，输出才不会漏在跳转那一拍里。
 */
export function useThreadCommands(
  api: ConversationApi,
  threadId: string,
  takePending?: (threadId: string) => string | undefined,
): ThreadCommands {
  const [list, setList] = useState<readonly SlashCommand[]>(NO_COMMANDS)
  const [output, setOutput] = useState<ThreadCommands['output']>(null)
  /* 正在跑的那一句：结果到了才开那一块，开的时候要知道是哪条命令说的 */
  const running = useRef('')

  const run = useCallback(
    async (text: string) => {
      const command = text.trim()
      running.current = command
      /*
       * 新命令先收掉上一块：上一条的结果到这里就算看过了。这一条有话要说时才出现 ——
       * 压缩、交接、改名、换模型的结果在时间线 / 标题 / 模型胶囊上，引擎不推，也就没有一块转圈等不到结果的框。
       */
      setOutput(null)
      try {
        await api.runCommand(threadId, command)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setOutput({ command, lines: [message] })
      }
    },
    [api, threadId],
  )

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
        held === null ? { command: running.current, lines: [p.text] } : { ...held, lines: [...held.lines, p.text] },
      )
    })
    /* 取走即消费：StrictMode 第二遍挂载取到的是空，不会执行两次 */
    const pending = takePending?.(threadId)
    if (pending !== undefined) void run(pending)
    return () => {
      live = false
      offChanged.dispose()
      offOutput.dispose()
    }
  }, [api, run, takePending, threadId])

  const dismissOutput = useCallback(() => setOutput(null), [])

  return useMemo(() => ({ list, output, run, dismissOutput }), [list, output, run, dismissOutput])
}
