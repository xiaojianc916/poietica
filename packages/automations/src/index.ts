/*
 * 包的唯一入口。逐个具名导出，不用 export *：这样「对外承诺了什么」是这一份
 * 文件读得出来的事实，而不是一次通配符展开的副作用。
 */

export { sessionConfigOf } from './automation'
/* 持有 store 的那一方要能说出它的名字：进程级常量的类型可命名性靠这一条。 */
export { type AutomationStore, createAutomationStore } from './automation-store'
export { AutomationsSurface } from './surface/automations-surface'
