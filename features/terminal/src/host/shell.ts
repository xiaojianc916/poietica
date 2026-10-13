import path from 'node:path'
import { which } from '@poietica/process-kit'

export interface ShellSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly title: string
}

export async function resolveShell(
  env: NodeJS.ProcessEnv,
  find: (name: string) => Promise<string | null> = which,
): Promise<ShellSpec> {
  const pwsh = await find('pwsh.exe')
  if (pwsh !== null) return { file: pwsh, args: ['-NoLogo'], title: 'pwsh' }
  const powershell = await find('powershell.exe')
  if (powershell !== null) return { file: powershell, args: ['-NoLogo'], title: 'powershell' }
  const comspec = env.ComSpec ?? env.COMSPEC
  if (comspec !== undefined && comspec.length > 0) {
    return { file: comspec, args: [], title: path.basename(comspec, path.extname(comspec)).toLowerCase() }
  }
  return { file: path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: [], title: 'cmd' }
}

export function terminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (k.startsWith('ELECTRON_') || k.startsWith('POIETICA_') || k === 'NODE_OPTIONS') continue
    out[k] = v
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  out.TERM_PROGRAM = 'Poietica'
  return out
}
