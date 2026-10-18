/**
 * browser relay 的 `/ext` 口令：Host 与 Core 启动契约的一部分（同 core-launch.ts 的参数与环境变量）。
 *
 * - **谁生成**：Host。每个数据根一份，放在 `DataLayout.relayTokenFile`（32 字节随机数的小写十六进制），
 *   每次拉起 Core 之前确保它在（host-kernel 的 ensureRelayToken）；Host 连 `/ext` 时带 `?token=`。
 * - **怎么到 relay**：Core 的环境变量只带**文件路径**（RELAY_TOKEN_FILE_ENV），不带口令本身 —— Core 的环境会一路传给
 *   agent 跑的 shell 命令，路径出现在 `env` 的输出里无害，口令出现在对话记录里就泄露了。relay 进程由 omp 的 broker
 *   用继承来的环境拉起，启动时读这个文件并补上 `--token`（engine-omp 的 withRelayToken）。
 * - **为什么持久化、不每次启动轮换**：broker 可能比这一代 Core 活得久，它的环境停在被拉起的那一刻；按数据根持久化后，
 *   路径与内容在各代 Core 之间都一致，broker 用旧环境拉起的 relay 读到的也是同一份口令。
 */
export const RELAY_TOKEN_FILE_ENV = 'POIETICA_RELAY_TOKEN_FILE'

const RELAY_TOKEN = /^[a-f0-9]{64}$/

/** 文件内容 → 口令；格式不对返回 null（Host 据此重建，relay 据此拒绝启动） */
export function parseRelayToken(text: string): string | null {
  const token = text.trim()
  return RELAY_TOKEN.test(token) ? token : null
}
