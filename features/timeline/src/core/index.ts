import { defineCoreModule } from '@poietica/core-kernel'
import { TimelineServiceToken } from '../core-api'
import { TimelineHub } from './timeline-hub'

export {
  BATCH_WINDOW_MS,
  RING_CAPACITY,
  RING_MAX_CHARS,
  TimelineChannel,
  TOOL_UPDATE_INTERVAL_MS,
} from './timeline-channel'
export { TimelineHub } from './timeline-hub'

export default defineCoreModule({
  id: 'timeline',
  setup(ctx) {
    const hub = new TimelineHub({ clock: ctx.clock })
    ctx.services.provide(TimelineServiceToken, hub)
    ctx.lifecycle.onShutdown(() => hub.dispose())
  },
})
