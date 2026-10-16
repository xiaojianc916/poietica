/*
 * 正文 / 思维链 / 插话帧的号（frameId）。
 *
 * 号必须由 **omp 自己的消息身份** 派生，而不是由「投影走到第几格」派生：增量那条路（LiveProjector）与
 * 历史那条路（projectHistoryPage）的段划分规则不同（前者一轮一段，后者一条助手消息一段、工具前后再切），
 * 按格数数号，两边对同一段话给出不同的号 —— 整页重取（压缩收口、补发缺口、Core 重启、切回线程）之后，
 * 界面上按号记的东西（虚拟列表的量高缓存、展开 / 收起状态）全部错位到别的行上。
 *
 * 工具帧早就是这个做法（`tool.<toolCallId>`），这里把其余三种补齐：
 * - 助手消息里的块：这一轮里第几条助手消息（从 0 数）+ 块在 content 数组里的下标（omp 流式事件的 contentIndex）；
 * - 插话：这一轮里第几句插话（从 1 数）；
 * - 其余上屏的非助手消息（custom 之类，只有历史那条路画）：单独一个名字空间，不挤占助手消息的序号。
 */
export function assistantFrameId(turn: string, message: number, block: number): string {
  return `${turn}.a${String(message)}.c${String(block)}`
}

export function interjectionFrameId(turn: string, ordinal: number): string {
  return `${turn}.u${String(ordinal)}`
}

export function extraFrameId(turn: string, message: number, block: number): string {
  return `${turn}.x${String(message)}.c${String(block)}`
}
