/*
 * 数据根：Electron 的 userData，一处决定（正本 docs/architecture/data-layout.md）。
 *
 * 安装版曾经把数据放在 exe 旁边，而 NSIS 的升级路径会先跑旧版的卸载器、把 $INSTDIR 整个
 * 搬走再删掉 —— 数据就在里面。userData 在安装器与卸载器都够不着的地方，这条冲突从根上
 * 不存在。位置由 main.ts 的 app.setPath('userData', …) 钉住。
 *
 * 这个应用未发布：盘上不存在别处的老数据，所以这里只把目录建出来，不搬任何东西。
 */
import { mkdir } from 'node:fs/promises'

export async function prepareDataRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
}
