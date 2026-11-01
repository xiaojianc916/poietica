import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { contractSnapshot } from '@poietica/contract-kit'
import { appContract } from '../src/index'
import { PROTOCOL_VERSION } from '../src/version'

interface Snapshot {
  readonly version: number
  readonly methods: unknown
  readonly notifications: unknown
  readonly errors: unknown
}

const file = path.join(import.meta.dir, '..', 'src', '__tests__', 'contract.snapshot.json')
const nextText = contractSnapshot(appContract, PROTOCOL_VERSION)
const next = JSON.parse(nextText) as Snapshot

/*
 * `protocol:snapshot` 无条件成功，等于把「形状变了必须提升版本」交给习惯。这里在**写盘前**挡住：
 * 同一版本号下 methods / notifications / errors 有任何变化就拒绝，先改 version.ts 再重跑。
 */
if (existsSync(file)) {
  const current = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
  const shapeChanged =
    JSON.stringify([current.methods, current.notifications, current.errors]) !==
    JSON.stringify([next.methods, next.notifications, next.errors])
  if (shapeChanged && current.version === next.version) {
    process.stderr.write(
      `契约形状变了，但 PROTOCOL_VERSION 仍是 ${PROTOCOL_VERSION}：先提升 packages/protocol/src/version.ts，再重新生成快照。\n`,
    )
    process.exit(1)
  }
}

writeFileSync(file, nextText)
