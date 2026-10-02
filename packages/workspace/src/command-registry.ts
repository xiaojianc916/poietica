export interface RegisteredCommand {
  readonly id: string
  readonly label: string
  /**
   * 行尾那一小行灰字：说清楚「是哪一个」。
   *
   * 同名的会话可以有很多条，只有标题的话人分不出来；这里放它所属的工作区。
   * 它参与检索 —— 打项目名就能把那个项目下的会话捞出来。
   */
  readonly detail?: string
  readonly shortcut?: string
  readonly when?: string
  readonly category?: string
  readonly execute: () => void | Promise<void>
}

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
  /**
   * 一次登记一批，全程只换一次快照、只通知一次。
   *
   * 会话列表每变一次就要把 N 条「打开某条会话」命令整批换掉（connections.ts 的
   * listChanged），逐条 register 会让每个订阅者被叫 2N 次：实测 1000 条会话
   * 7.11 ms、2000 次回调，而订阅者里两个都要重建整张键位表。
   * 登记同样的命令逐条做与批量做语义完全一样，区别只是中间态算不算数 —— 不算。
   */
  readonly registerAll: (commands: readonly RegisteredCommand[]) => () => void
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

  function registerAll(next: readonly RegisteredCommand[]): () => void {
    const ids: string[] = []

    for (const command of next) {
      if (commands.has(command.id)) {
        /* 半批已登记时回退，别把调用方留在半个状态上。 */
        for (const id of ids) {
          commands.delete(id)
        }
        throw new Error(`COMMAND_ALREADY_REGISTERED: ${command.id}`)
      }
      commands.set(command.id, command)
      ids.push(command.id)
    }

    emit()

    let live = true
    return () => {
      if (!live) {
        return
      }
      live = false
      for (const id of ids) {
        commands.delete(id)
      }
      emit()
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
    registerAll,
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
