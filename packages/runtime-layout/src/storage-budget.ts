/**
 * 数据根里各类**缓存**的预算：Host 的 Chromium 会话按它压住，platform 的存储页按它解释。
 *
 * 不设预算时 Chromium 按磁盘剩余空间自己定上限（net/disk_cache/cache_util.cc 的 PreferredCacheSize）：剩余空间够大时，
 * Windows 上**每个会话**的 HTTP 缓存最多 320 MB，V8 代码缓存 js 部分最多 320 MB、wasm 部分最多 480 MB。
 * 应用有两个持久会话（主窗口的 defaultSession 与内置浏览器分区），于是「浏览器缓存」会一路涨到 1 GB 以上才停 ——
 * 涨的过程看上去就是泄漏。对一个主要由 agent 浏览的内置浏览器，热数据远小于这个量级。
 *
 * - HTTP 缓存：`--disk-cache-size`，Electron 对每个持久会话都用它做 network context 的 http_cache_max_size，
 *   满了由 Chromium 自己按 LRU 淘汰（app-identity.ts 在 ready 之前设置）；
 * - V8 代码缓存：Electron 不给大小开关（GetGeneratedCodeCacheSettings 传 0 = 走上面的启发式），只能由 Host 在启动后
 *   量一次、超出就整份清掉（`session.clearCodeCaches`，platform 的 storage-service.enforceBudgets）。
 */
export const CHROMIUM_HTTP_CACHE_BYTES = 128 * 1024 * 1024
export const CHROMIUM_CODE_CACHE_BYTES = 64 * 1024 * 1024
