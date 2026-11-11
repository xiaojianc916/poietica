import { captureLaunchEnv } from '@poietica/runtime-protocol-omp/bootstrap'

/*
 * 独立 Runtime 可执行文件的入口（P3b）。Core 只负责领域与编排，omp 及其依赖全部留在
 * poietica-runtime.exe 里；Core 通过 ARP 握手按需拉起它。
 */
const launchEnv = captureLaunchEnv()
const { runRuntimeMode } = await import('./runtime-main')
await runRuntimeMode(launchEnv)
