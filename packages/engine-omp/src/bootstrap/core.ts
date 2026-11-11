/* Core 只需要隔离与 stdout 守卫；单独一条入口，避免把 runtime 的进程模式与 omp 一起拖进 Core 包。 */
export { type IsolationResult, isolationEnv, prepareIsolation } from './isolation-env'
export { type IsolationSelfCheck, runIsolationSelfCheck } from './self-check'
export { installStdoutGuard, resetStdoutGuardForTest, stdoutWriteFrame } from './stdout-guard'
