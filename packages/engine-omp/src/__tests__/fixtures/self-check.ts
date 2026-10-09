// T-ISO-3 夹具：把 omp 的目录指到隔离根之外，自检必须报 not ok。
import { dataLayout } from '@poietica/runtime-layout'
import { runIsolationSelfCheck } from '../../bootstrap/self-check'

const layout = dataLayout(process.env.POIETICA_TEST_ROOT!)
const outside = process.env.POIETICA_OUTSIDE!
process.env.PI_CONFIG_DIR = outside
process.env.PI_CODING_AGENT_DIR = outside
process.env.XDG_DATA_HOME = outside

const report = await runIsolationSelfCheck(layout)
process.stdout.write(JSON.stringify({ ok: report.ok, violations: report.violations }))
