import path from 'node:path'
import { runHostKernel } from '@poietica/host-kernel'
import { windowsExecutable } from '@poietica/platform-kit'
import { appContract, PROTOCOL_VERSION } from '@poietica/protocol'
import { app } from 'electron'
import { hostModules } from './modules'

// 构建产物位于 apps/desktop/out/main/index.cjs，因此 __dirname = apps/desktop/out/main
const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../resources')
runHostKernel({
  modules: hostModules,
  appContract,
  protocolVersion: PROTOCOL_VERSION,
  appVersion: app.getVersion(),
  paths: {
    preload: path.join(__dirname, '../preload/index.cjs'),
    rendererFile: path.join(__dirname, '../renderer/index.html'),
    rendererDevUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    coreExe: app.isPackaged
      ? path.join(process.resourcesPath, 'core', windowsExecutable('poietica-core'))
      : path.join(__dirname, '../../../core/dist', windowsExecutable('poietica-core')),
    resourcesDir,
  },
})
