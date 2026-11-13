import { captureLaunchEnv } from '@poietica/runtime-protocol-omp/bootstrap'

/*
 * 独立 Runtime 可执行文件的入口（P3b）。Core 只负责领域与编排，omp 及其依赖全部留在
 * poietica-runtime.exe 里；Core 通过 ARP 握手按需拉起它。
 *
 * 同一个 exe 还承担维护子进程：`poietica-runtime.exe gc --agent-dir <dir>`。
 * 媒体回收必须另起进程（omp 的 gc 写 stdout），这里在连接 ARP 之前分流。
 */
if (process.argv[2] === 'gc') {
  const { runMaintenance } = await import('@poietica/runtime-protocol-omp/bootstrap')
  process.exit(await runMaintenance(process.argv.slice(3)))
}

const launchEnv = captureLaunchEnv()
const { runRuntimeMode } = await import('./runtime-main')
await runRuntimeMode(launchEnv)
