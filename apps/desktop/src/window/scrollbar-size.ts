const SIZE = '--desktop-scrollbar-size'

/**
 * 量一次操作系统的滚动条有多宽，写成一个自定义属性。
 *
 * 为什么必须量：CSS 里没有任何东西说得出这个宽度。scrollbar-gutter: stable
 * 让浏览器预留了那条沟，但预留了多少不对样式表公开 —— 而输入框那条带子要
 * 让开它，否则它盖住滚动条的最后一段，而且它自己会比消息列宽出一整条沟。
 *
 * 这是业界的标准量法（Bootstrap 的 scrollbar-width、Radix 与 Floating UI 的
 * 同名工具都是这一段）：一个离屏的强制滚动盒，边框盒宽减内容盒宽就是那条沟。
 *
 * 量一次就够。它是操作系统的常量，不随窗口、缩放或主题改变 —— 所以这里没有
 * 观察者，也没有需要回收的东西。它归 chrome 层而不是某个组件，正是因为它
 * 描述的是这台机器，不是界面上的任何一个盒子。
 */
export function installScrollbarSize(): void {
  const probe = document.createElement('div')

  probe.style.position = 'absolute'
  probe.style.insetBlockStart = '0'
  probe.style.insetInlineStart = '0'
  probe.style.inlineSize = '100px'
  probe.style.blockSize = '100px'
  probe.style.overflowY = 'scroll'
  probe.style.visibility = 'hidden'

  document.body.append(probe)

  const size = probe.offsetWidth - probe.clientWidth

  probe.remove()

  document.documentElement.style.setProperty(SIZE, `${String(size)}px`)
}
