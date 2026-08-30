import { createBrowserPanelStore } from '@poietica/browser'
import { browserHostPort } from '@poietica/native-bridge'

export const browserPanelStore = createBrowserPanelStore(browserHostPort)
