import { resolveShell as resolvePlatformShell, type ShellSpec } from '@poietica/platform-kit'
import { which } from '@poietica/process-kit'

export type { ShellSpec }

/** 终端 shell 的选择规则在 platform-kit；这里只把宿主可用的 `which` 注入进去。 */
export function resolveShell(
  env: NodeJS.ProcessEnv,
  find: (name: string) => Promise<string | null> = which,
): Promise<ShellSpec> {
  return resolvePlatformShell(env, find)
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
