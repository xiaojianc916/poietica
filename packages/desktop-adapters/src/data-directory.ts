import { commands } from '@poietica/contract'

/**
 * 这台机器上，这个应用的数据落在哪。
 *
 * 路径由原生侧算，不在这里拼。落点的唯一真相是 apps/desktop/src-tauri/src/paths.rs：
 * 它认安装期写下的声明，认不到才回到平台默认位置。渲染层照着「%LOCALAPPDATA% 加
 * 产品名」再拼一次，在用户装到 D 盘的那一刻就会说错 —— 而这一行的全部意义正是让
 * 用户知道去哪儿备份。说错了的路径比不显示有害得多。
 *
 * 不经过 @poietica/ipc 的包装出口：那一层此刻只会是一行转发，而 settings-store.ts
 * 走的就是生成绑定本身。多一层只多一个要同步的名字。
 */
export function readDataDirectory(): Promise<string> {
  return commands.storageDataDirectory()
}
