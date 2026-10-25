import { type Dirent, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/*
 * Windows 任务栏按键画的是「该 AppUserModelID 对应快捷方式」的那张图；窗口自己的 WM_SETICON
 * 只管窗口本体，`setAppDetails` 也压不过已存在的快捷方式。只要某个快捷方式声称我们的 AUMID
 * 而 target 已经丢失，任务栏就永远画通用白纸图并按 AUMID 缓存 —— 这里只修「身份是我们的、
 * 且确实指丢了」的那些，名字、目录、指向别处的一概不碰。
 */

/** `shell.readShortcutLink()` 的返回值里我们关心的部分 */
export interface AppShortcut {
  readonly target: string
  readonly appUserModelId?: string
}

export interface DesiredAppShortcut {
  readonly appId: string
  readonly target: string
  readonly args: string
  readonly cwd: string
  readonly icon: string
  readonly description: string
}

export interface RepairAppShortcutsOptions {
  /** %APPDATA%\Microsoft\Windows\Start Menu\Programs */
  readonly programsDir: string
  readonly desired: DesiredAppShortcut
  readonly listShortcuts?: (dir: string) => string[]
  readonly readShortcut: (file: string) => AppShortcut
  readonly writeShortcut: (file: string, desired: DesiredAppShortcut) => boolean
}

/** 递归列出目录下所有 .lnk。目录不存在或读不动都当空：修不了不该拦住启动。 */
export function listShortcutFiles(dir: string): string[] {
  const found: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listShortcutFiles(full))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) found.push(full)
  }
  return found
}

/** 把「我们的身份 + target 已丢失」的快捷方式改回正确指向，返回真正修好的文件。 */
export function repairAppShortcuts(o: RepairAppShortcutsOptions): string[] {
  const list = o.listShortcuts ?? listShortcutFiles
  const repaired: string[] = []
  for (const file of list(o.programsDir)) {
    let link: AppShortcut
    try {
      link = o.readShortcut(file)
    } catch {
      continue
    }
    // 身份不是我们的：无论坏成什么样都不归这里管
    if (link.appUserModelId !== o.desired.appId) continue
    if (existsSync(link.target)) continue
    let ok = false
    try {
      ok = o.writeShortcut(file, o.desired)
    } catch {
      ok = false
    }
    if (ok) repaired.push(file)
  }
  return repaired
}

/**
 * 启动时的一次性自愈：把「声称我们身份、target 已经丢失」的快捷方式改回正确指向。
 * 只在开发版做 —— 安装版的快捷方式由 NSIS 写、指向安装目录；开发版指向 electron.exe，
 * 换一次依赖就断一次。任何异常只记日志不抛：图标丑不能挡住启动。
 */
export function repairDevShortcutsOnBoot(o: {
  readonly desired: DesiredAppShortcut
  readonly programsDir: string
  readonly readShortcut: (file: string) => AppShortcut
  readonly writeShortcut: (file: string, desired: DesiredAppShortcut) => boolean
  readonly warn: (message: string, fields: Record<string, unknown>) => void
}): string[] {
  try {
    const repaired = repairAppShortcuts({
      programsDir: o.programsDir,
      desired: o.desired,
      readShortcut: o.readShortcut,
      writeShortcut: o.writeShortcut,
    })
    // 这一条必须留着：它是「任务栏图标为什么突然变了」唯一可查的记录
    if (repaired.length > 0) {
      o.warn('repaired stale app shortcuts (taskbar icon was reading a dead target)', { repaired })
    }
    return repaired
  } catch (e) {
    o.warn('scanning app shortcuts failed', { error: String(e) })
    return []
  }
}
