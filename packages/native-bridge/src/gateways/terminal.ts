import type { TerminalHostPort } from '@poietica/auxiliary/terminal'
import { commands, events } from '@poietica/contract'
import { throughIpc } from '../error'

/*
 * 端口的每一格就是一条 IPC 命令。base64 只活在这个文件里：事件与命令走 JSON，
 * 而 PTY 说的是字节 —— 编解码是适配层的职责，两侧的词汇都不该染上它。
 * 编解码本体用平台自带的 atob / btoa，不手搓字母表与填充。
 */

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function encode(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function throughIpcVoid(operation: () => Promise<unknown>): Promise<void> {
  return throughIpc(operation).then(() => undefined)
}

export const terminalHostPort: TerminalHostPort = {
  watch: (root, onSignal) =>
    events.terminalStreamed.listen((event) => {
      if (event.payload.root !== root) {
        return
      }

      const chunk = event.payload.chunk

      onSignal(
        chunk.kind === 'output'
          ? { bytes: decode(chunk.value), kind: 'output' }
          : { kind: 'exited' },
      )
    }),

  attach: (root, cols, rows) => throughIpcVoid(() => commands.terminalAttach(root, cols, rows)),

  write: (root, bytes) => throughIpcVoid(() => commands.terminalWrite(root, encode(bytes))),

  resize: (root, cols, rows) => throughIpcVoid(() => commands.terminalResize(root, cols, rows)),

  close: (root) => throughIpcVoid(() => commands.terminalClose(root)),
}
