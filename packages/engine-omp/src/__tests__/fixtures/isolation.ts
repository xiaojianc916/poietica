// T-ISO-2 夹具：设一个错的 PI_CODING_AGENT_DIR，再调 prepareIsolation。
import { dataLayout } from '@poietica/runtime-layout'
import { prepareIsolation } from '../../bootstrap/isolation-env'

const root = process.env.POIETICA_TEST_ROOT!
process.env.PI_CODING_AGENT_DIR = 'C:\\definitely-wrong'
process.env.OMP_PROFILE = 'someone-elses-profile'
process.env.XDG_CONFIG_HOME = 'C:\\somewhere'

const result = prepareIsolation(dataLayout(root))
process.stdout.write(JSON.stringify({ corrected: result.corrected, removed: result.removed, cwd: process.cwd() }))
