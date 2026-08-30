import { useEffect, useRef, useState } from 'react'

/**
 * 一个变化不许快过 holdMs 的值。
 *
 * 它解决的是「事实变得比眼睛快」：几条调用各跑几十毫秒时，如实跟着换字会让每一次切换
 * 都在动画播完之前被下一次打断，那不叫流畅，那叫抖。
 *
 * 压着的期间不排队。到点之后交出去的是那一刻的最新值，中间跳过的几个不补播 —— 补播出
 * 来的是一段已经过去的历史，而这一格说的是「现在」。
 *
 * 第一次变化不压：changedAt 从负无穷起步，于是等待时间算出来是 0。刚出现的那一组不该
 * 先愣半秒才开口。
 */
export function useHeldValue<T>(value: T, holdMs: number): T {
  const [shown, setShown] = useState(value)
  const changedAt = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    if (Object.is(value, shown)) {
      return
    }

    /* 依赖里带着 shown：交出去之后这个 effect 会再跑一次，那一次两边相等，上面就退出了。 */
    const wait = Math.max(0, holdMs - (performance.now() - changedAt.current))

    const timer = setTimeout(() => {
      changedAt.current = performance.now()
      setShown(value)
    }, wait)

    /* value 在压着的期间又变了：这条清理会把上一个定时器撤掉，新的 effect 用同一个
       changedAt 重新算剩余时间。被跳过的那个值就此消失，这正是「不排队」。 */
    return () => {
      clearTimeout(timer)
    }
  }, [holdMs, shown, value])

  return shown
}
