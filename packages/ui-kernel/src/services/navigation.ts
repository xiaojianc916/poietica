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
  /** preferences 在启动时恢复上次的位置（不进入历史） */
  restore(route: Route): void
}

const MAX_HISTORY = 50
const sameRoute = (a: Route, b: Route): boolean =>
  a.surface === b.surface && JSON.stringify(a.params) === JSON.stringify(b.params)

export function createNavigationService(defaultRoute: Route): NavigationService {
  let back: Route[] = []
  let fwd: Route[] = []
  const state = createValue<NavigationState>({ route: defaultRoute, canGoBack: false, canGoForward: false })
  const publish = (route: Route): void => state.set({ route, canGoBack: back.length > 0, canGoForward: fwd.length > 0 })
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
      publish(route)
    },
  }
}
