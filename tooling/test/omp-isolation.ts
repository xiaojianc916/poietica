/*
 * 测试进程的 omp 隔离：把 omp 的全部落盘目录指到一个一次性的测试数据根，进程退出时删掉。
 * 必须在 preload 里做 —— omp 的目录在模块求值时读环境变量算出、整个进程只算一次，bun test
 * 又把所有测试文件放进同一个进程；逐文件 import 夹具的约定漏一个就把配置写进开发者的 ~/.omp。
 * 隔离变量与 Host 拉起 Core 用的是同一份定义（runtime-layout 的 ompIsolationEnv），不抄字面量。
 */
import { afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { isInside } from '@poietica/fs-kit'
import { dataLayout, ompIsolationEnv } from '@poietica/runtime-layout'

/** 测试数据根所在的环境变量（engine-omp 的 __tests__/omp-home.ts 按这个名字读，取 testLayout） */
const TEST_DATA_ROOT_ENV = 'POIETICA_TEST_DATA_ROOT'

/**
 * 测试数据根必须在用户目录之下（omp 把 PI_CONFIG_DIR 当成相对用户目录的名字）：Windows 用
 * %TEMP%，Linux / macOS 的 /tmp 不满足、退到 ~/.cache。CI runner 的 tmpdir() 是 8.3 短名，先归一。
 */
function parentDir(home: string): string {
  const tmp = realpathSync.native(tmpdir())
  if (isInside(home, tmp)) return tmp
  const cache = path.join(home, '.cache')
  mkdirSync(cache, { recursive: true })
  return cache
}

export function isolateOmpForTests(env: Record<string, string | undefined> = process.env): string {
  const existing = env[TEST_DATA_ROOT_ENV]
  if (existing) return existing
  const home = realpathSync.native(homedir())
  const root = mkdtempSync(path.join(parentDir(home), `poietica-test-${process.pid}-`))
  const layout = dataLayout(root)
  Object.assign(env, ompIsolationEnv(home, layout))
  env[TEST_DATA_ROOT_ENV] = root
  // natives 加载器只在 <XDG_DATA_HOME>/omp 已存在时才认 XDG_DATA_HOME（同 engine-omp 的 prepareIsolation）
  for (const dir of [layout.ompAgentDir, path.join(layout.nativeHomeDir, 'omp', 'natives'), layout.coreCwd]) {
    mkdirSync(dir, { recursive: true })
  }
  // bun test 不发 process 'exit' 事件；preload 里登记的 afterAll 是全局的，在所有测试文件跑完后执行
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上没关掉的 omp 句柄会让删除失败；Windows 的数据根在 %TEMP% 里，交给系统清理
    }
  })
  return root
}
