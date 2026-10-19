// omp 的测试隔离由仓库根的 preload（tooling/test/omp-isolation.ts）在任何测试文件求值之前完成，
// 测试文件不需要、也不应该再自己设隔离变量。这里只把那次准备好的数据根交给要用它的测试。
import { type DataLayout, dataLayout } from '@poietica/runtime-layout'

const root = process.env.POIETICA_TEST_DATA_ROOT
if (!root) {
  // 没走根目录的 bunfig（例如在包目录里直接 bun test）：omp 已经按真实用户目录算好了路径，必须停下
  throw new Error('omp 测试隔离没有生效：请在仓库根目录运行 bun test（preload 只登记在根 bunfig.toml）')
}

export const testLayout: DataLayout = dataLayout(root)
