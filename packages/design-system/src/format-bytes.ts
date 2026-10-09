/*
 * 字节数的界面写法：B / KB / MB，一位小数。
 *
 * 住在设计系统里是因为它有两个读者（技能详情的辅助文件总量、设置页的存储一格）：
 * 两份实现必然分叉，而「1.5 MB」这种写法是排版，不是业务。
 */
export function formatBytes(value: number): string {
  const format = (amount: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(amount)

  if (value < 1024) {
    return `${format(value)} B`
  }

  if (value < 1024 * 1024) {
    return `${format(value / 1024)} KB`
  }

  return `${format(value / (1024 * 1024))} MB`
}
