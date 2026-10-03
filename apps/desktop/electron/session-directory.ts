/*
 * 内核那摊子从数据根里分出去：<数据根>/session（Electron 的 sessionData）。
 *
 * Chromium 的缓存、代码缓存与分区存储不是我们的数据，寿命与体积也不归我们管；混在数据根
 * 里有两件事永远说不清 —— 这个应用占了多大地方，以及「清理」该清哪一处。分开之后数据根
 * 只剩账本、设置、附件与工具，内核那一摊在一处，一眼可见、一处可清（设置页「存储」）。
 *
 * 落点由 main.ts 的 app.setPath('sessionData', …) 交给 Electron —— Chromium 自己会在这个
 * 目录下铺它要的一切，这里不预先建任何一层：建了也只是建给下一次启动看。
 */

export const SESSION_DIRECTORY = 'session'

/** 能从上游重取的：清掉只有下次慢一点。默认会话与内置浏览器分区各有一份。 */
export const KERNEL_CACHE_ENTRIES: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
]
