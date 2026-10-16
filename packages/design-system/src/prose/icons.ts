import { CalendarDays, Check, Code, Copy } from 'lucide-react'
import { createElement, type FunctionComponent, type SVGProps } from 'react'

/* 正文要的几枚字形。语义名照 conversation 那张映射表（PreviewIcon 就是 CalendarDays），换字形改这里。 */
export { CalendarDays as PreviewIcon, Check as CheckIcon, Code as CodeIcon, Copy as CopyIcon }

/* streamdown 的 IconMap 要 `{ className?, size? }`：按「没有就不传」转发 —— 显式传 undefined 与压根不传在 exactOptionalPropertyTypes 之下是两件事。 */
export function asIcon(
  glyph: FunctionComponent<{ className?: string; size?: number }>,
): FunctionComponent<SVGProps<SVGSVGElement> & { readonly size?: number }> {
  return ({ className, size }) =>
    createElement(glyph, {
      ...(className === undefined ? {} : { className }),
      ...(size === undefined ? {} : { size }),
    })
}
