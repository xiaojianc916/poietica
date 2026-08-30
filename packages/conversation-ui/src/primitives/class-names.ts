/**
 * 类名拼接，只此一处。
 *
 * 这里拼的全是 assistant-* / timeline-* 这类 BEM 类名，没有 Tailwind 的属性
 * 冲突可解，所以不走设计系统的 cn（clsx + tailwind-merge）——换过去只是白跑
 * 一遍冲突表。但它也不该在某个组件文件里各自私有一份。
 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}
