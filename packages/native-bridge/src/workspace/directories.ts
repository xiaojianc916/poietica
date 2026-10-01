import { commands } from '@poietica/contract'
import { hostBridge } from '../host-bridge'
import { throughIpc } from '../ipc-error'

/*
 * 工作目录：让人挑一个。
 *
 * 目录选择器是宿主能力：对话框挂在窗口上，只有 Electron 主进程开得出来
 * （原生侧没有窗口，那条 workspace_pick_root 因此是空壳）。所以这里走宿主端口，
 * 不走命令面 —— 走命令面会拿到一个永远失败的 internal。
 *
 * 选完之后往哪儿放不是这一层的事。它不碰持久化，也不认识 activeWorkspaceRoot ——
 * 那份状态住在桌面应用里（apps/desktop/src/workspace/roots.ts），这一层只把系统
 * 的回答运过来。
 */

/** 开系统的文件夹选择器。人按了取消就是 null。 */
export function pickWorkspaceRoot(): Promise<string | null> {
  return hostBridge().host.pickRoot()
}

/**
 * 为下一条无项目会话申请一个独立工作目录。
 *
 * 路径由原生层创建并返回；这一层不拼应用数据目录，也不制造 UUID。
 */
export function createProjectlessWorkspace(): Promise<string> {
  return throughIpc(() => commands.workspaceCreateProjectlessRoot())
}
