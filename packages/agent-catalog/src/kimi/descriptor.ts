import type { AgentDescriptor } from '../agent-descriptor'

/*
 * Kimi Code CLI 的档案。
 *
 * 事实来源是它自己的源码，不是观察和猜测：MoonshotAI/kimi-code。每一条下面都
 * 注明具体是哪个文件的哪个函数。
 *
 * 我们接的是 kap：kimi web --no-open 起的本地服务（kap-server），REST +
 * WebSocket，协议快照钉在 contracts/kap（bun run kap:spec）。
 */

/*
 * 启动是一个可执行名加一串参数，不是一行待解析的命令行：拼成字符串再拆回来是
 * 有损的 —— Windows 路径里的反斜杠会被 POSIX 词法当成转义符吃掉，带空格的路径
 * 会被切断。
 */
export const kimiCode = {
  id: 'kimi',
  displayName: 'Kimi Code',
  command: 'kimi',
  /*
   * 本地服务模式：同一个进程挂 REST + WebSocket 与 web UI，--no-open 不起
   * 浏览器（docs/en/reference/kimi-command.md 的 kimi web）。
   */
  args: ['web', '--no-open'],
  // 让每个 PowerShell 版本按自己的 $PSHOME 重建模块路径，避免跨版本模块遮蔽。
  unsetEnv: ['PSModulePath'],
  // apps/kimi-code/src/config/paths.ts 的 resolveKimiHome：
  // homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code')。
  homeVar: 'KIMI_CODE_HOME',
  // 同一行 resolveKimiHome 的最后一个回落，也就是没有受控 home 时它自己去的地方。
  ownHomeDirectory: '.kimi-code',
  install: { packageName: '@moonshot-ai/kimi-code', versionArgs: ['--version'] },
} as const satisfies AgentDescriptor
