import { defineCoreModule } from '@poietica/core-kernel'
import { browserContract } from '../contract'

/**
 * browser 的 Core 半边只做一件事：把引擎自己挑的 relay 端口转给本功能的 Host 半边。
 * 以前这条线走「Host 挑端口 → 启动参数 → Core」，于是 CoreSupervisor、CoreCaller、启动契约都认识 relay；
 * 现在内核只是转发一个普通的 RPC，relay 只出现在引擎端口与本功能里。
 */
export default defineCoreModule({
  id: 'browser',
  contract: browserContract,
  setup(ctx) {
    ctx.rpc.handle('browser.relayEndpoint', () => ({ port: ctx.engine.browserRelay()?.port ?? null }))
  },
})
