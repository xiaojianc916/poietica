/**
 * 数据根里各类**缓存**的预算：Host 的 Chromium 会话按它压住，platform 的存储页按它解释。
 * 不设预算时 Chromium 按磁盘剩余空间自己定上限：Windows 上每个会话的 HTTP 缓存最多 320 MB、
 * V8 代码缓存 js 320 MB / wasm 480 MB；应用有两个持久会话，「浏览器缓存」会一路涨到 1 GB 以上
 * 才停 —— 涨的过程看上去就是泄漏，而内置浏览器的热数据远小于这个量级。
 * HTTP 缓存走 `--disk-cache-size`（app-identity.ts 在 ready 之前设置，满了 Chromium 自己 LRU）；
 * V8 代码缓存没有大小开关，只能由 Host 启动后量一次、超出整份清掉（platform 的
 * storage-service.enforceBudgets 调 `session.clearCodeCaches`）。
 */
export const CHROMIUM_HTTP_CACHE_BYTES = 128 * 1024 * 1024
export const CHROMIUM_CODE_CACHE_BYTES = 64 * 1024 * 1024
