/*
 * 这个包的公开面：桥与 Rust 的线上形状，以及 omp 事件到 transcript ops 的投影。
 *
 * main.ts 不是公开面：它是被编成可执行文件的入口，不是给别人 import 的模块。
 */

export { TranscriptProjector } from './projection.ts'
export {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeFrame,
  type GoalSnapshot,
  type SelectorChoice,
  type SelectorControl,
  type UsageSnapshot,
} from './protocol.ts'
export { TranscriptMirror } from './transcript-mirror.ts'
