import type { AgentDescriptor } from '../agent-descriptor'

/*
 * oh-my-pi（omp）的档案。
 *
 * 事实来源是它自己的仓库与包，不是观察和猜测：can1357/oh-my-pi，
 * npm @oh-my-pi/pi-coding-agent（锚定 18.3.0）。每一条下面都注明出处。
 *
 * 我们不经 kap：omp 没有本地服务模式，它给的是 SDK 与 stdio 上的 RPC/ACP。
 * 这里接的是**随包发的一份 Bun 运行时加我们的桥**（packages/agent-bridge 的
 * `src/main.ts`，由 tools/agent/prepare-runtime.ts 收成 bundle），桥把 omp 的 SDK
 * 装在里面，对 Rust 说 NDJSON。用户因此不需要装 omp、也不需要装 Bun（见 ADR 0021）。
 *
 * 不追官方的 `--mode rpc|acp`：那条命令面缺我们一半的命令（settings_catalog、
 * model_catalog、mcp_servers、skills、delete_session、browser_settings），追过去
 * 会变成「官方协议 + 自定义扩展」两套并存。传输线上形状是我们的 protocol.ts。
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
   * 随包发的 Bun 运行时，与应用可执行文件同目录（Tauri 的 bundle.resources 摆的），
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
  // 运行时开关留给以后：入口由 entry 那一格给，不放这儿。
  args: [],
  /*
   * 从子进程环境里摘掉的两格：
   *
   * - `PSModulePath`：让每个 PowerShell 版本按自己的 $PSHOME 重建模块路径，避免
   *   跨版本模块遮蔽。
   * - `PI_COMPILED`：我们**不是**编译出来的二进制。`isCompiledBinary()` 的第一判据
   *   读的就是这个变量（pi-utils/src/env.ts:466-470），而它一为真，SDK 与加载器就有
   *   三处按「编译态」改道（2026-09 实测，锚定 18.3.0）：
   *     1. pi-natives 的候选表会**多出用户目录并排在最前**（`resolveLoaderCandidates`：
   *        `~/.omp/natives/<版本>/`、`%LOCALAPPDATA%\omp`）—— 别人机器上残留的一份
   *        会优先于我们随包发的那个被加载。我们只要随包的那一份，来源要确定。
   *     2. SDK 的 CLI 入口块会**在进程里**跑起来（`src/cli.ts:601` 的 `isProcessEntry`）：
   *        那是第二个入口，和我们抢同一根 stdout。
   *     3. worker 子进程的启动命令换成 `[运行时, "__omp_worker_*"]`（把选择器当文件名），
   *        而不是 `[运行时, 入口, 选择器]`。
   *
   * 只「构建期不折」不够：它读的是运行时环境，宿主里恰有一个就静默改道。官方 npm
   * 发行版也是不设它、只折 `PI_BUNDLED`。
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
