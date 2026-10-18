/* 测试用的「Core 入口」：与 apps/core/src/main.ts 走同一个 dispatchProcessMode，只认维护模式 */
import { dispatchProcessMode } from '../../../bootstrap/process-mode'

await dispatchProcessMode()
process.stderr.write('不是维护模式\n')
process.exit(3)
