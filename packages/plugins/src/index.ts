/*
 * 包的公开面。逐个具名导出，不用 export *：对外承诺了什么，读这一份文件就够。
 *
 * fetch-plan 与 marketplace 的内部结构不在这里露头 —— 取用计划怎么拼、目录怎么解，
 * 是这个包自己的事，外面只需要「装了什么、市场上有什么、界面长什么样」。
 */

export { createPluginStore, type PluginStore, type PluginsViewModel } from './plugin-store'
export { PluginsSurface } from './surface/plugins-surface'
