import { join } from 'node:path'

/*
 * 原生库的落点，一处。
 *
 * 与 native.ts 分开是因为这里必须能在没有 electron 的环境里被测到：那条路径错过一次 ——
 * 打包后 extraResources 把库放在 resources/native/，而加载器按 asarUnpack 那条路去找
 * app.asar.unpacked/native/，目录是空的，用户装上一启动就是「原生库加载失败」。
 * 路径逻辑不可测，就会再错一次。
 */

/** 找原生库需要知道的四件事；由调用方从 electron 的 app 上读出来交进来。 */
export interface NativeLookup {
  readonly override: string | undefined
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
}

/**
 * 候选路径按「谁是这次运行的真身」排序，全都不存在时把每一条与原始错误一起报出去 ——
 * 只说一句「加载失败」的话，开发机上分不出是没编译还是路径猜错了。
 */
export function nativeCandidates(lookup: NativeLookup): readonly string[] {
  if (lookup.override !== undefined && lookup.override.length > 0) {
    return [lookup.override]
  }

  if (lookup.isPackaged) {
    /*
     * 打包后的落点是 resources/native/poietica.node —— electron-builder.yml 的
     * extraResources 把它摆在 asar 外面。
     *
     * 不是 app.asar.unpacked：asarUnpack 只把**打进 asar 的文件**抽出来，而 extraResources
     * 根本不经 asar。按 unpacked 那条路找，目录是空的，启动就是「原生库加载失败」。
     */
    return [join(lookup.resourcesPath, 'native', 'poietica.node')]
  }

  // 开发期：tools/dev/build-native.ts 把 cdylib 改名成 .node 放在 cargo 自己的 target 下。
  // 它与 .dll 同级，所以不会出现「.node 是上一次构建、.dll 是这一次」的陈旧副本。
  //
  // 两条候选而不是一条：appPath 在开发期取决于谁把 Electron 拉起来的 ——
  // electron-vite 从 dist-electron 起（三层到仓库根），直接 `electron .` 从 apps/desktop
  // 起（两层）。写死一条就会在另一种跑法下找不到插件，而这里本来就是一个候选列表。
  const addon = ['debug', 'release'].map((profile) => join('target', profile, 'poietica.node'))

  return [
    ...addon.map((relative) => join(lookup.appPath, '..', '..', '..', relative)),
    ...addon.map((relative) => join(lookup.appPath, '..', '..', relative)),
  ]
}
