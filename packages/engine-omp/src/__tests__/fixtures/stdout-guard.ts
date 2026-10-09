// T-ISO-1 夹具：装守卫 → console.log → process.stdout.write → writeFrame，
// 只有最后那个能到真正的 stdout。
import { installStdoutGuard } from '../../bootstrap/stdout-guard'

const writeFrame = installStdoutGuard()
console.log('from-console-log')
process.stdout.write('from-stdout-write\n')
writeFrame('\x1e{"ok":true}\n')
