/*
 * 这个包的公开面：omp 事件到 transcript ops 的投影，以及桥与 Rust 的线上形状。
 *
 * `main.ts` 与 `bridge.ts` 都不在这张清单上：前者是 Rust spawn 起来的 stdio 适配器，
 * 后者是它 import 的 Bun 代码（SDK、node:fs、pi-natives 都在里面）。把它们摆进来，
 * 等于让每一个只想用投影的调用方都拖上整个 SDK。
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
