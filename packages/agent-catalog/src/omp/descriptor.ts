import type { AgentDescriptor } from '../agent-descriptor'

/*
 * oh-my-pi（omp）的档案。
 *
 * 事实来源是它自己的仓库与包，不是观察和猜测：can1357/oh-my-pi，
 * npm @oh-my-pi/pi-coding-agent（锚定 18.2.11）。每一条下面都注明出处。
 *
 * 我们不经 kap：omp 没有本地服务模式，它给的是 SDK 与 stdio 上的 RPC/ACP。
 * 这里接的是**我们自己编出来的那个可执行文件**（packages/agent-bridge 的入口，
 * 由 tools/agent/build-bridge.ts 收成单文件），它把 omp 的 SDK 装在里面，
 * 对 Rust 说 NDJSON。用户因此不需要装 omp（见 ADR 0052）。
 */

/*
 * 启动是一个可执行名加一串参数，不是一行待解析的命令行：拼成字符串再拆回来是
 * 有损的 —— Windows 路径里的反斜杠会被 POSIX 词法当成转义符吃掉，带空格的路径
 * 会被切断。
 */
export const ohMyPi = {
  id: 'omp',
  displayName: 'Oh My Pi',
  /*
   * 随包发的边车名。Tauri 把 externalBin 放在应用可执行文件旁边，解析顺序见
   * crates/process-host/src/program.rs 的 resolve_sidecar：先找同目录，再回落到
   * PATH（开发期直接跑源码版桥时用得上）。
   */
  command: 'poietica-agent',
  // 桥自己认协议，不需要命令行开关；参数留给以后。
  args: [],
  // 让每个 PowerShell 版本按自己的 $PSHOME 重建模块路径，避免跨版本模块遮蔽。
  unsetEnv: ['PSModulePath'],
  /*
   * src/utils/dirs.ts 的 getAgentDir：受控时读 process.env.PI_CODING_AGENT_DIR
   * （绝对路径的 agent 目录）。PI_CONFIG_DIR 只是 home 下的目录名，不是路径，不用它。
   */
  homeVar: 'PI_CODING_AGENT_DIR',
  // src/utils/dirs.ts 的 resolveAgentDir 的最后一个回落：没有受控 home 时它自己去 ~/.omp/agent。
  ownHomeDirectory: '.omp',
} as const satisfies AgentDescriptor
