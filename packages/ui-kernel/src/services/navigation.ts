import { createValue, type Observable } from './observable'

export interface Route {
  readonly surface: string
  readonly params: Readonly<Record<string, string>>
}
export interface NavigationState {
  readonly route: Route
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

export interface NavigationService extends Observable<NavigationState> {
  navigate(route: Route, opts?: { replace?: boolean }): void
  back(): void
  forward(): void
  home(): void
  /** preferences 在启动时恢复上次的位置，不进入历史。 */
  restore(route: Route): void
}

/**
 * 换路由时套的那层过渡。由组合根注入：内核不认识 design-system，也不知道有没有 View Transition API。
 * `update` 必须同步落定，否则新快照拍在旧 DOM 上，补出来是同一张脸。
 */
export type RouteTransition = (update: () => void, type: string) => void

/** 换路由的类型名，外壳的 CSS 用 `:active-view-transition-type()` 认领：换表面与换参数是两种观感。 */
export const ROUTE_TRANSITION_TYPE = 'ui-route'

const MAX_HISTORY = 50
const sameRoute = (a: Route, b: Route): boolean =>
  a.surface === b.surface && JSON.stringify(a.params) === JSON.stringify(b.params)

export function createNavigationService(defaultRoute: Route, transition?: RouteTransition): NavigationService {
  let back: Route[] = []
  let fwd: Route[] = []
  const state = createValue<NavigationState>({ route: defaultRoute, canGoBack: false, canGoForward: false })
  const publish = (route: Route): void => {
    const next = { route, canGoBack: back.length > 0, canGoForward: fwd.length > 0 }
    if (transition === undefined) {
      state.set(next)
      return
    }
    transition(() => {
      state.set(next)
    }, ROUTE_TRANSITION_TYPE)
  }
  return {
    current: state.current,
    subscribe: state.subscribe,
    navigate(route, opts) {
      const cur = state.current().route
      if (sameRoute(cur, route)) return
      if (opts?.replace !== true) back = [...back, cur].slice(-MAX_HISTORY)
      fwd = []
      publish(route)
    },
    back() {
      const prev = back.at(-1)
      if (prev === undefined) return
      back = back.slice(0, -1)
      fwd = [state.current().route, ...fwd]
      publish(prev)
    },
    forward() {
      const next = fwd[0]
      if (next === undefined) return
      fwd = fwd.slice(1)
      back = [...back, state.current().route]
      publish(next)
    },
    home() {
      this.navigate(defaultRoute)
    },
    restore(route) {
      back = []
      fwd = []
      /* 启动时恢复上次的位置：那一帧还没有「旧画面」可比，起过渡只会让外壳淡入一次。 */
      state.set({ route, canGoBack: false, canGoForward: false })
    },
  }
}
