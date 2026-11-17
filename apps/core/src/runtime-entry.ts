import { captureLaunchEnv, dispatchChildMode } from '@poietica/runtime-protocol-omp/bootstrap'

/*
 * 独立 Runtime 可执行文件的入口（P3b）。Core 只负责领域与编排，omp 及其依赖全部留在
 * poietica-runtime.exe 里；Core 通过 ARP 握手按需拉起它。
 *
 * 这个 exe 同时也是 omp 的 worker 宿主：workerHostEntry()（编译版 = Bun.main）让所有 worker 线程与
 * IPC 子进程重新进入同一个 exe，argv[2] 是选择子。dispatchChildMode 必须在这里、在 runtime 主模式之前
 * 调用——漏掉它，eval 的隔离子进程会落进 runtime 模式、在「缺少 --data-root」处 exit(2)，
 * 表现为「Failed to initialize isolated JS eval worker: JS eval worker exited」，computer 跟着整块不可用。
 * 同一个分派还承担维护子进程（`gc --agent-dir <dir>`）：omp 的 gc 写 stdout，必须另起进程。
 */
const launchEnv = captureLaunchEnv()
await dispatchChildMode()

const { runRuntimeMode } = await import('./runtime-main')
await runRuntimeMode(launchEnv)
