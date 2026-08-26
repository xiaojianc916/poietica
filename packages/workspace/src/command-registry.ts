import type { RegisteredCommand } from './command-contract'

/*
 * 贡献表，不是展示表。
 *
 * 快照按注册次序给出。此前 emit 里挂着一个 compareCommands，按 category 再
 * label 做 localeCompare —— 那有两个问题：
 *
 *   - 「应用」排在「视图」前面纯属汉字码点凑巧，不是任何人的决定；
 *   - 会话是按最近活动排好序进来的，一进来就被按标题重排，最近打开的那条
 *     沉到中间。排序权在贡献者手里，注册表替它做主就是把信息弄丢。
 *
 * 次序因此是声明出来的：谁先注册谁先出现（见 app-commands.ts 那张表；命令
 * 面板按分组首次出现的先后画组）。要改顺序去改声明，不必猜比较器。
 */
export interface CommandRegistry {
  readonly register: (command: RegisteredCommand) => () => void
  readonly execute: (commandId: string) => Promise<boolean>
  readonly getSnapshot: () => readonly RegisteredCommand[]
  readonly subscribe: (listener: () => void) => () => void
}

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, RegisteredCommand>()
  const listeners = new Set<() => void>()
  let snapshot: readonly RegisteredCommand[] = []

  function emit(): void {
    snapshot = Array.from(commands.values())
    for (const listener of listeners) {
      listener()
    }
  }

  function register(command: RegisteredCommand): () => void {
    if (commands.has(command.id)) {
      throw new Error(`COMMAND_ALREADY_REGISTERED: ${command.id}`)
    }

    commands.set(command.id, command)
    emit()

    let registered = true
    return () => {
      if (!registered) {
        return
      }
      registered = false
      commands.delete(command.id)
      emit()
    }
  }

  async function execute(commandId: string): Promise<boolean> {
    const command = commands.get(commandId)
    if (!command) {
      return false
    }
    await command.execute()
    return true
  }

  return {
    register,
    execute,
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
