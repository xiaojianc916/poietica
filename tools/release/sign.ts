/**
 * 用 Tauri 官方签名器给一个文件出分离签名。
 *
 * 仓库里不出现第二套 minisign 实现：安装包、更新载荷、增量补丁全走这一处。
 * 私钥与密码从环境变量取，由调用方装载（见 tools/release/release.ts 的 loadSigningKey）。
 * 调用方的工作目录必须是仓库根目录：签名器只在 apps/desktop 下找得到。
 */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 签名落在 <file>.sig 旁边，返回它的内容。 */
export async function sign(file: string): Promise<string> {
  const signed = spawnSync('bun', ['run', 'tauri', 'signer', 'sign', path.resolve(file)], {
    cwd: 'apps/desktop',
    encoding: 'utf8',
  })

  if (signed.status !== 0) {
    console.error(signed.stderr)
    throw new Error(`signing ${file} failed`)
  }

  return (await readFile(`${file}.sig`, 'utf8')).trim()
}
