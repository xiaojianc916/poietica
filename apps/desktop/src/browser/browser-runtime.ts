import { createBrowserPanelStore } from '@poietica/browser'

import { browserHostPort } from './browser-host-port'

export { browserHostPort } from './browser-host-port'

export const browserPanelStore = createBrowserPanelStore(browserHostPort)
