import path from 'node:path'
import { type DataLayout, dataLayout } from '@poietica/runtime-layout'

/** 测试用的 DataLayout：全部路径都落在给定的临时目录之下 */
export function memoryLayout(root: string): DataLayout {
  return dataLayout(path.resolve(root))
}
