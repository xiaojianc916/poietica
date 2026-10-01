import { hostBridge } from '../host-bridge'

/**
 * 这个应用自己的版本号。
 *
 * 它是更新清单里拿去比对的那一个数，所以只能有一个产地：打包配置写进 app 的那一版，
 * 由宿主读出来。渲染层另写一份（写死的字符串、从 package.json 注入的构建期常量）就是给
 * 版本号再开一个真相来源，报障时双方说的不是一件事。
 */
export function readAppVersion(): Promise<string> {
  return hostBridge().host.appVersion()
}
