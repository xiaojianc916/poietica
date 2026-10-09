/**
 * 按 Windows（MSVCRT / CommandLineToArgvW）规则给单个参数加引号。只在必须拼接命令行字符串时使用；
 * 正常调用子进程一律用参数数组（run / spawnStreaming），不需要它。
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`
    } else {
      out += '\\'.repeat(backslashes) + ch
    }
    backslashes = 0
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}
