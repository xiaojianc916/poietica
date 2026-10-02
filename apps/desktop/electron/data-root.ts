/*
 * 数据根：Electron 的 userData，外加把 ≤0.4.3 的老位置搬过来。
 *
 * 这里不 import electron：搬运是纯粹的目录操作，能不能测取决于有没有宿主。
 * 宿主事实（userData 在哪、老位置在哪）由 main.ts 算好交进来。
 *
 * 为什么数据根是 userData：安装版曾经把数据放在 exe 旁边，而 NSIS 的升级路径会先跑
 * 旧版的卸载器，模板在 `--updated` 那一支把 $INSTDIR 整个搬走再删掉 —— 数据就在里面，
 * 于是每次更新都清空用户数据。userData 在安装器与卸载器都够不着的地方。
 */
import { access, cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 从一个老数据根搬过来的东西。
 *
 * 只搬状态：logs / tmp / cache 丢了能自己再长出来，tools 是 60MB 的解释器、用到时重装。
 * 名字是 apps/desktop/native/src/paths.rs 那几张常量的抄本，正本在那个文件。
 *
 * 一次性：老位置再也不会有新数据，搬过一次之后就什么也找不到。
 */
export const LEGACY_DATA_ENTRIES: readonly string[] = [
  'settings.json',
  'agents.json',
  'automations.json',
  /* WAL 三件套要一起搬：只搬主文件会丢掉最近一段还没并回去的写入。 */
  'ledger.sqlite3',
  'ledger.sqlite3-wal',
  'ledger.sqlite3-shm',
  'agents',
  'attachments',
  'plugins',
  'projectless',
]

/**
 * 建好新数据根，并把 `legacies` 里还剩下的东西搬进来。
 *
 * 冲突一律让新根赢：目标已经存在就跳过 —— 新根里的那份是这一版真正在用的，
 * 老位置里的是上一版留下的。
 */
export async function adoptDataRoot(root: string, legacies: readonly string[]): Promise<void> {
  await mkdir(root, { recursive: true })

  for (const legacy of legacies) {
    if (legacy !== root) {
      await adoptEntries(legacy, root)
    }
  }
}

async function adoptEntries(legacy: string, root: string): Promise<void> {
  for (const name of LEGACY_DATA_ENTRIES) {
    const source = join(legacy, name)
    const target = join(root, name)

    if (!(await exists(source)) || (await exists(target))) {
      continue
    }

    try {
      await cp(source, target, { recursive: true })
      /* 搬完才删源：上面这一步抛异常时老位置一个字都不动，下次启动还能再来一遍。 */
      await rm(source, { recursive: true, force: true })
    } catch (cause) {
      console.warn('老数据根没有搬干净', name, cause)
    }
  }
}

/** 存在性判据：读得到就是有。 */
function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
