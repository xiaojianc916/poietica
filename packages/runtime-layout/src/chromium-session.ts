/**
 * 内置浏览器的持久分区名。它决定数据根里 `session/Partitions/poietica-browser` 这个目录，与 `chromiumSessionDir`、
 * 缓存预算（./storage-budget）同属「数据根里有什么」：browser 用它开分区，platform 的存储页用它量、用它清。
 *
 * 两个功能都只认这一份，谁也不必认识谁。它曾住在 browser 的 contract 里，platform（功能分级的最底层）为这一个
 * 字符串反过来依赖了插件，并经 browser → conversation → platform 成环。
 */
export const BROWSER_PARTITION = 'persist:poietica-browser'
