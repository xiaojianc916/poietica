/*
 * 弹层一打开，里面的输入框就拿到焦点。
 *
 * 不用 autoFocus：那是页面加载期的语义，a11y 规则拦它是对的。callback ref 在节点
 * 真正出现的那一刻跑，正是弹层需要的时机。写成模块级常量而不是内联箭头，引用才
 * 稳定 —— 否则每敲一个字都会卸载重挂一次 ref。
 */
export function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus()
}
