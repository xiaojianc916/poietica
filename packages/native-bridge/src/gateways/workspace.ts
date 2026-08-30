import { commands } from '@poietica/contract'
import { throughIpc } from '../error'

/*
 * 工作目录：让人挑一个。
 *
 * 只有一条命令，因为渲染层只需要一个答案 —— 一个绝对路径，或者「没选」。
 * 目录选择器是系统的，开它要 dialog 插件，而插件的 IPC 面不交给 webview：
 * 这一层调的是我们自己那条 workspace_pick_root，理由写在 commands/workspace.rs。
 *
 * 选完之后往哪儿放不是这一层的事。它不碰持久化，也不认识 activeWorkspaceRoot ——
 * 那份状态住在桌面应用里（apps/desktop/src/entry/workspace-root.ts），这一层只把系统
 * 的回答运过来。
 */

/** 开系统的文件夹选择器。人按了取消就是 null。 */
export function pickWorkspaceRoot(): Promise<string | null> {
  return throughIpc(() => commands.workspacePickRoot())
}

/**
 * 为下一条无项目会话申请一个独立工作目录。
 *
 * 路径由原生层创建并返回；这一层不拼应用数据目录，也不制造 UUID。
 */
export function createProjectlessWorkspace(): Promise<string> {
  return throughIpc(() => commands.workspaceCreateProjectlessRoot())
}
