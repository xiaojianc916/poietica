// 为 UI 测试提供 DOM 全局对象（document、window…）。Core / Host 代码的运行时纯度由 tsconfig 预设保证，不靠测试环境。
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/', width: 1440, height: 900 })
