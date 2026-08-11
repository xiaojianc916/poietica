import { throughIpc } from './error'
import { commands } from './generated/ipc-bindings'

/*
 * 工作台开着哪几格：运过去，运回来。
 *
 * 文档是不透明的。这一层不认识它的形状 —— 认识它的是 @poietica/workspace，
 * 因为一格标签指向什么由那一侧的 surface-registry 说了算。原生那一侧同样
 * 不认识：它只保证这份文档活过一次重启。
 */

/** 上一次留下的那一份。第一次启动是 null。 */
export function readWorkbenchSession(): Promise<string | null> {
  return throughIpc(() => commands.workbenchSessionLoad())
}

/** 记下工作台此刻的样子。整份覆盖。 */
export function writeWorkbenchSession(document: string): Promise<void> {
  return throughIpc(() => commands.workbenchSessionSave(document))
}
