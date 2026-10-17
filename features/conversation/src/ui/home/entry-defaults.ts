import type { ModelRef } from '@poietica/engine'
import type { ComposerStore } from '../composer'

/*
 * 入口页的模型 / 档位**不是**一份本地状态：它就是「新对话默认」那一份持久意图（omp 的 `modelRoles.default:档位`，
 * 与模型页的「设为默认」、自动化取的默认同源）。原先它只写 UI 本地草稿，和引擎那份默认各管各的，启动时
 * 两份谁先到谁赢 —— 问题 1 的根。这里把草稿降成「还没落账的那一笔」：人一选就写穿意图，写成功就从草稿里抹掉。
 */

export interface EntryDefaultChoice {
  /** null = 只改档位：由 Core 解出此刻显示的那条模型 */
  readonly model: ModelRef | null
  /** 省略 = 保留意图里原来的档位 */
  readonly thinking?: string
}

export interface EntryDefaultsOptions {
  readonly composer: ComposerStore
  /** 写穿意图（conversation 契约的 `controls.setDraft`） */
  readonly write: (choice: EntryDefaultChoice) => Promise<void>
  /** 写失败只影响「下次开窗还记不记得」：草稿留着、下次再写，交给调用方上报 */
  readonly report?: ((cause: unknown) => void) | undefined
}

export interface EntryDefaults {
  /**
   * 把草稿里还没落账的模型 / 档位写成默认意图。同一时刻只有一次在写；写的途中又调用的，等这一次写完
   * 按最新草稿再写一次（不并发：两次写后发先至，盘上会留下旧的那一笔）。
   */
  flush(): Promise<void>
}

export function createEntryDefaults({ composer, report, write }: EntryDefaultsOptions): EntryDefaults {
  let running: Promise<void> | null = null
  let again = false

  const once = async (): Promise<void> => {
    const held = composer.selectionOf(null)
    const model = held.model ?? null
    const thinking = held.thinking ?? undefined
    if (model === null && thinking === undefined) return
    const choice: EntryDefaultChoice = { model, ...(thinking === undefined ? {} : { thinking }) }
    try {
      await write(choice)
    } catch (cause: unknown) {
      report?.(cause)
      return
    }
    composer.settleSelection(null, {
      ...(model === null ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
    })
  }

  const drain = async (): Promise<void> => {
    do {
      again = false
      await once()
    } while (again)
  }

  return {
    flush() {
      if (running !== null) {
        again = true
        return running
      }
      running = drain().finally(() => {
        running = null
      })
      return running
    },
  }
}
