import './styles.css'
import { engineErrorMessages } from '@poietica/engine'
import { appContract } from '@poietica/protocol'
import { createUiKernel, KernelProvider } from '@poietica/ui-kernel'
import { Workbench, workbenchFeature } from '@poietica/workbench'
import { createRoot } from 'react-dom/client'
import { uiFeatures } from './features'

/*
 * 量一次系统滚动条多宽，写成 --desktop-scrollbar-size。
 *
 * 会话里输入框下方那条实色带、页头那道雾，都靠它让开滚动条（surface.css 两处
 * inset-inline）；CSS 说不出这个宽度，漏掉这一步两处都兜底成 0px，实色带便铺满
 * 整宽、压住滚动条。量法照 legacy：一个离屏的强制滚动盒，边框盒宽减内容盒宽。
 */
const scrollbarProbe = document.createElement('div')
scrollbarProbe.style.position = 'absolute'
scrollbarProbe.style.inlineSize = '100px'
scrollbarProbe.style.blockSize = '100px'
scrollbarProbe.style.overflowY = 'scroll'
scrollbarProbe.style.visibility = 'hidden'
document.body.append(scrollbarProbe)
document.documentElement.style.setProperty(
  '--desktop-scrollbar-size',
  `${String(scrollbarProbe.offsetWidth - scrollbarProbe.clientWidth)}px`,
)
scrollbarProbe.remove()

const HOME_ROUTE = { surface: 'conversation.home', params: {} } as const
const DEMO_ROUTE = { surface: 'design-system.demo', params: {} } as const

/**
 * 首屏路由。`#/__ds` 由 design-system-demo 功能在 core ready 之后再认一次
 * （见 features.ts），这里只给一个不会白屏的起点。
 */
const demoRequested = import.meta.env.DEV && window.location.hash === '#/__ds'

const kernel = createUiKernel({
  features: [workbenchFeature, ...uiFeatures],
  errorMessages: { ...engineErrorMessages, ...appContract.errorMessages },
  validateResults: import.meta.env.DEV,
  defaultRoute: demoRequested ? DEMO_ROUTE : HOME_ROUTE,
})
await kernel.start()
createRoot(document.getElementById('root')!).render(
  <KernelProvider kernel={kernel}>
    <Workbench />
  </KernelProvider>,
)
