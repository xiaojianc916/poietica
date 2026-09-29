/* 探一个 CDP 端点此刻还有没有人在听。单独一处：启动对齐要拿它区分「上一趟留下的死端点」
 * 与「用户自己选的一台现成浏览器」，而测试不该依赖这台机器上恰好有没有东西在跑。
 *
 * 探活归原生侧（渲染进程没有网络能力），这里只是把那条命令包成一段可替换的依赖。 */

import { browserEndpointReachable } from '@poietica/native-bridge/browser'

export function isAlive(endpoint: string): Promise<boolean> {
  return browserEndpointReachable(endpoint)
}
