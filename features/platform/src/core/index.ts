import { defineCoreModule } from '@poietica/core-kernel'
import { platformContract } from '../contract'

export default defineCoreModule({
  id: 'platform',
  contract: platformContract,
  setup(ctx) {
    ctx.rpc.handle('diagnostics.core', () => ({
      coreVersion: ctx.runtime.coreVersion,
      engineVersion: ctx.runtime.engineVersion,
      dataRoot: ctx.layout.root,
      ompRoot: ctx.layout.ompRoot,
      // 关于页把这些目录展示出来，就是给用户看的“隔离证明”
      dirs: {
        ompAgentDir: ctx.layout.ompAgentDir,
        nativeHomeDir: ctx.layout.nativeHomeDir,
        coreCwd: ctx.layout.coreCwd,
        dbFile: ctx.layout.dbFile,
        attachmentsDir: ctx.layout.attachmentsDir,
        scratchDir: ctx.layout.scratchDir,
        toolsDir: ctx.layout.toolsDir,
        pythonDir: ctx.layout.pythonDir,
        logsDir: ctx.layout.logsDir,
        chromiumSessionDir: ctx.layout.chromiumSessionDir,
      },
      scrubbedEnvKeys: [...ctx.runtime.scrubbedEnvKeys],
    }))
    ctx.rpc.handle('diagnostics.setLogLevel', ({ level }) => {
      ctx.runtime.setLogLevel(level)
      return {}
    })
  },
})
