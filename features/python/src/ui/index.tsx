/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { builtinPoints, defineUiFeature } from '@poietica/ui-kernel'
import { createPythonApi } from './api'
import { PythonKernelGroup } from './python-settings'

export default defineUiFeature({
  id: 'python',
  setup(ctx) {
    const api = createPythonApi(ctx)

    /*
     * 「运行时」那一组落在**通用页**里（legacy 的位置），不再单占导航一格。
     * `page` 是设置页 id 的纯字符串，所以这里不认识 preferences 功能（守则 3）。
     */
    ctx.contribute(builtinPoints.settingsSections, {
      id: 'python.runtime',
      order: 600,
      page: 'preferences.general',
      component: () => <PythonKernelGroup api={api} />,
    })
  },
})
