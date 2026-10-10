/**
 * 协议版本（05 页 §8 的 version.ts 只放这一个常量）。
 *
 * 规则：**任何**契约形状变化都要提升这个数字，并运行 `bun run protocol:snapshot` 重新生成快照。
 * Host 与 Core 总是一起发布，版本号只用来发现「安装损坏」或「开发时忘了重新构建 Core」。
 */
export const PROTOCOL_VERSION = 13
