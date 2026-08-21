import './pixel-loader.css'

import { cn } from './class-names'

const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/**
 * 运行态：一件还在跑的事，画成一方点阵。
 *
 * 它只说「在跑」，不说跑了多久：谁在跑由放它的那一行、那一格自己的名字回答。
 * 纯装饰，所以 aria-hidden；状态由宿主元素的 aria-busy 承担。
 */
export function PixelLoader({ className }: { readonly className?: string }) {
  return (
    <span aria-hidden="true" className={cn('ui-pixel-loader', className)}>
      {CELLS.map((cell) => (
        <span className="ui-pixel-loader__cell" key={cell} />
      ))}
    </span>
  )
}
