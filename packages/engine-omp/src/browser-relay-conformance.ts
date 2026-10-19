/*
 * 类型级对齐检查：我方的 browser relay 线上形状（@poietica/engine 的 browser-relay.ts）对 omp 的
 * `tools/browser/relay/protocol.ts`。omp 的这份协议是它的内部契约、没有版本号，以前靠 AGENTS 里「升级 omp 时人工核对」
 * 维持一致，结果 cdpEvent 的 params 已经漂成了 `unknown`。现在交给 `bun run typecheck`：任何一侧改了形状，下面的
 * 赋值检查就编译不过。本文件没有运行时代码，也不被任何人 import —— 它只为 typecheck 存在。
 *
 * 方向：relay → 扩展的消息我们**收**（omp 发的每一种都得认得）；扩展 → relay 的消息我们**发**（发的每一种 omp 都得收）。
 */
import type {
  ExtToRelayMessage,
  DISCARDED_TABS_PROTOCOL_VERSION as OmpDiscardedTabsProtocolVersion,
  TabSnapshot as OmpTabSnapshot,
  RelayToExtMessage,
} from '@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol'
import type { DISCARDED_TABS_PROTOCOL_VERSION, RelayInbound, RelayOutbound, TabSnapshot } from '@poietica/engine'

type Assignable<From, To> = [From] extends [To] ? true : false
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

export type BrowserRelayConformance = [
  /** omp 发来的每一种消息，我方的 RelayInbound 都认得 */
  Assert<Assignable<RelayToExtMessage, RelayInbound>>,
  /** 我方发出的每一种消息，omp 的 ExtToRelayMessage 都收 */
  Assert<Assignable<RelayOutbound, ExtToRelayMessage>>,
  Assert<Same<TabSnapshot, OmpTabSnapshot>>,
  /** hello 带的能力号与 omp 的闸门同值（见 browser-relay.ts 文件头：对不上整实例判成不 eligible） */
  Assert<Same<typeof DISCARDED_TABS_PROTOCOL_VERSION, typeof OmpDiscardedTabsProtocolVersion>>,
]
