/** 拼的全是 BEM 类名，没有 Tailwind 属性冲突可解，所以不走设计系统的 cn（clsx + tailwind-merge）。 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}
