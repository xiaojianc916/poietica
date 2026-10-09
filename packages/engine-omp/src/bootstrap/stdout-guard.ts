/**
 * stdout 是 Core 与 Host 之间的帧通道。omp 与它的依赖里到处是 console.log，
 * 任何一行杂散输出都会被 Host 当成 stray 行。守卫把 stdout 全部改道到 stderr，
 * 只留下 writeFrame 能写真正的 stdout（12 页 §4.3）。
 */
let installed: ((frame: string) => void) | null = null

type Write = typeof process.stdout.write

export function installStdoutGuard(target: NodeJS.WriteStream = process.stdout): (frame: string) => void {
  if (installed !== null) throw new Error('installStdoutGuard 只能调用一次')
  const realWrite = target.write.bind(target) as Write
  const toStderr = (chunk: string): void => {
    process.stderr.write(chunk)
  }
  target.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean => {
    // 一切非帧输出都改道到 stderr（含 Buffer 与带回调的写法）
    toStderr(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    if (typeof encoding === 'function') (encoding as () => void)()
    else if (typeof callback === 'function') (callback as () => void)()
    return true
  }) as Write
  const format = (args: readonly unknown[]): string =>
    `${args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' ')}\n`
  for (const name of ['log', 'info', 'debug', 'trace', 'dir', 'table'] as const) {
    // 这个文件的职责就是把 console 改道到 stderr；biome.json 按精确路径豁免 noConsole。
    console[name] = ((...args: unknown[]) => toStderr(format(args))) as never
  }
  const writeFrame = (frame: string): void => {
    realWrite(frame)
  }
  installed = writeFrame
  return writeFrame
}

/** 测试用：拿到已安装的 writeFrame（未安装时为 null） */
export function stdoutWriteFrame(): ((frame: string) => void) | null {
  return installed
}

/** 测试用：还原守卫（只用于同一进程里跑多个用例） */
export function resetStdoutGuardForTest(): void {
  installed = null
}
