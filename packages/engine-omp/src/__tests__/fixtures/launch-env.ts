// T-ISO-4 夹具：cwd 下放一个含 FOO_INJECTED=1 的 .env，captureLaunchEnv → 触发 pi-utils 的 .env 加载 → scrubInjected。
import { captureLaunchEnv } from '../../bootstrap/launch-env'

const envDir = process.env.POIETICA_ENV_DIR!
process.chdir(envDir)
const snapshot = captureLaunchEnv()
// pi-utils 在求值时把 .env 注入环境变量
await import('@oh-my-pi/pi-utils')
const removed = await snapshot.scrubInjected()
process.stdout.write(JSON.stringify({ removed, stillThere: process.env.FOO_INJECTED !== undefined }))
