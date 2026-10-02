import type { AgentDescriptor } from '../agent-descriptor'

/*
 * oh-my-pi（omp）的档案。事实来源是它自己的仓库与包：can1357/oh-my-pi，
 * npm @oh-my-pi/pi-coding-agent（锚定 18.3.0）。
 *
 * 不经 kap（omp 没有本地服务模式）；不追官方的 `--mode rpc|acp`：那条命令面缺
 * settings_catalog 等一半命令，追过去会成「官方协议 + 自定义扩展」两套并存。
 */

/*
 * 启动是一个可执行名加一串参数，不是一行待解析的命令行：拼成字符串再拆回来是
 * 有损的 —— Windows 路径里的反斜杠会被 POSIX 词法当成转义符吃掉，带空格的路径
 * 会被切断。
 */
export const ohMyPi = {
  id: 'omp',
  /*
   * 随包发的 Bun 运行时（electron-builder 的 extraResources 摆到 resources/agent/），
   * 解析顺序见 crates/process-host/src/program.rs 的 resolve_sidecar：先找同目录，
   * 再回落到 PATH —— 开发期手动跑源码版桥时用得上。
   *
   * 不写 `omp`：官方 CLI 是用户自己要装的东西，而产品的前提是「只装 Poietica」
   * （ADR 0016）。
   */
  command: 'bun',
  /*
   * 桥的入口，同一个目录。SDK 的宿主只能是 Node/Bun 进程：它 109 个文件 import
   * `node:fs`、323 个文件用 Bun API，还依赖 pi-natives 的 NAPI `.node`，`engines`
   * 只认 bun（ADR 0021 的实测表）。所以程序名是运行时，入口是脚本。
   */
  entry: 'poietica-bridge.js',
  args: [],
  /*
   * `PSModulePath`：让 PowerShell 按 $PSHOME 重建模块路径。`PI_COMPILED` 是
   * `isCompiledBinary()` 的第一判据（pi-utils/src/env.ts:466-470），它读运行时环境，
   * 一为真就有三处按「编译态」改道（2026-09 实测）：pi-natives 候选表混入用户目录且
   * 排最前（残留包盖过随包那份）、CLI 入口块在进程内抢 stdout（src/cli.ts:601）、
   * worker 启动形状变成 `[运行时, "__omp_worker_*"]` —— 所以必须 unset。
   */
  unsetEnv: ['PSModulePath', 'PI_COMPILED'],
  /*
   * src/utils/dirs.ts 的 getAgentDir：受控时读 process.env.PI_CODING_AGENT_DIR
   * （绝对路径的 agent 目录）。PI_CONFIG_DIR 只是 home 下的目录名，不是路径，不用它。
   */
  homeVar: 'PI_CODING_AGENT_DIR',
  // src/utils/dirs.ts 的 resolveAgentDir 的最后一个回落：没有受控 home 时它自己去 ~/.omp/agent。
  ownHomeDirectory: '.omp',
} as const satisfies AgentDescriptor
