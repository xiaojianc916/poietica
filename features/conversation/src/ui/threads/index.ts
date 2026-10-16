/*
 * threads 区：线程列表、标题、生命周期与每线程的回合状态。区与区之间只能经本文件互相引用。
 */
export { createThreadsStore, type ThreadsStore } from './threads-store'
export { createTurnStatesStore, type TurnStatesStore } from './turn-states'
export { ThreadTitleMenu } from './view/thread-title-menu'
