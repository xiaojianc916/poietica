import { stat } from 'node:fs/promises'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** Windows 的环境变量名不区分大小写，但复制出来的普通对象区分：按不区分大小写的方式取值 */
function getEnv(env: Env, name: string): string | undefined {
  const upper = name.toUpperCase()
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper) return v
  return undefined
}

function pathEntries(env: Env = process.env): string[] {
  return (getEnv(env, 'PATH') ?? '')
    .split(';')
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter((p) => p.length > 0)
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * 在 PATH 中查找可执行文件，返回绝对路径；找不到返回 null。
 * name 不带扩展名时按 PATHEXT 依次尝试；name 含路径分隔符时只检查该路径本身；不缓存结果
 * （用户可能在应用运行期间安装 git）。
 * **不要换成 `Bun.which`**，三条实测缺口：忽略 PATHEXT；只看进程启动时的 PATH 快照；
 * 不认带引号的条目。而且调用方在 Electron 主进程 —— 那里没有 `Bun`，本签名正好按注入的 env 查。
 */
export async function which(name: string, env: Env = process.env): Promise<string | null> {
  const exts =
    path.extname(name) !== ''
      ? ['']
      : (getEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
  if (name.includes('\\') || name.includes('/')) {
    for (const ext of exts) if (await isFile(name + ext)) return path.resolve(name + ext)
    return null
  }
  for (const dir of pathEntries(env)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (await isFile(candidate)) return candidate
    }
  }
  return null
}
