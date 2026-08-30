import { getVersion } from '@tauri-apps/api/app'

/**
 * 这个可执行文件自己的版本号。
 *
 * Tauri 把 tauri.conf.json 的 version 编译进二进制，getVersion() 读的就是它 ——
 * 也正是更新器拿去和 latest.json 比对的那一个数。任何在渲染层另写一份的做法
 * （写死的字符串、构建期从 package.json 注入的 import.meta.env）都是给版本号
 * 再开一个真相来源，而那些来源迟早会和更新器认定的版本对不上：用户看到的版本
 * 和软件认为自己是的版本不是同一个东西，报障时双方说的就不是一件事。
 *
 * 官方能力，不经过一条自定义 IPC 命令。需要的权限是 core:app:allow-version，
 * 它来自 core:app:default，而 capabilities/main-window.json 已经声明了
 * core:default。
 */
export function readAppVersion(): Promise<string> {
  return getVersion()
}
