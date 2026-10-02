import { commands } from '@poietica/contract'
import { throughIpc } from './ipc-error'

/*
 * 内置 Python 内核的三个出口。与 usage.ts 同形：这一层只把契约命令转成 Promise，形状
 * 一个字都不在这里声明 —— 原生侧是契约的产地，三条命令交回的是同一份状态。
 *
 * 端口在 @poietica/settings/ui 那一侧声明，这里按结构满足它；两边的形状是否还对得上由
 * 组合根（apps/desktop/src/workbench/workspace.tsx 的 pythonKernel 属性）的编译期断言钉住。
 */

export const pythonKernelGateway = {
  status: () => throughIpc(() => commands.pythonKernelStatus()),
  install: () => throughIpc(() => commands.pythonKernelInstall()),
  remove: () => throughIpc(() => commands.pythonKernelRemove()),
}
