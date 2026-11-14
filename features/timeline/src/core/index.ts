import { defineCoreModule } from '@poietica/core-kernel'
import { EventRouterFactoryToken, TimelineServiceToken } from '../core-api'
import { EventRouter } from './event-router'
import { TimelineHub } from './timeline-hub'

export { EventRouter } from './event-router'
export {
  BATCH_WINDOW_MS,
  RING_CAPACITY,
  RING_MAX_CHARS,
  TimelineChannel,
  TOOL_UPDATE_INTERVAL_MS,
} from './timeline-channel'
export const createEventRouter = (deps: import('../core-api').EventRouterDeps): EventRouter => new EventRouter(deps)
export { TimelineHub } from './timeline-hub'

export default defineCoreModule({
  id: 'timeline',
  setup(ctx) {
    const hub = new TimelineHub({ clock: ctx.clock })
    ctx.services.provide(TimelineServiceToken, hub)
    ctx.services.provide(EventRouterFactoryToken, createEventRouter)
    ctx.lifecycle.onShutdown(() => hub.dispose())
  },
})
