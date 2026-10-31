/*
 * 字节数的界面写法：B / KB / MB，一位小数。
 *
 * 住在设计系统里是因为它有两个读者（技能详情的辅助文件总量、设置页的存储一格）：两份实现必然
 * 分叉，而「1.5 MB」这种写法是排版，不是业务。
 */
/* Intl.NumberFormat 构造一次就够：每次调用重建比格式化本身还贵。 */
const BYTES_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${BYTES_FORMAT.format(value)} B`
  }

  if (value < 1024 * 1024) {
    return `${BYTES_FORMAT.format(value / 1024)} KB`
  }

  return `${BYTES_FORMAT.format(value / (1024 * 1024))} MB`
}
