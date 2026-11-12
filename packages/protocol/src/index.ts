import { composeContracts } from '@poietica/contract-kit'
import { featureContracts } from './contracts.generated'
/**
 * 全应用契约汇总。以后每加一个功能，就在这里合并它的契约——这是唯一需要修改的地方。
 * systemContract 由 composeContracts 自动并入。
 */
export const appContract = composeContracts(...featureContracts)

export { contractSnapshot } from '@poietica/contract-kit'
/**
 * 协议版本在 ./version.ts：05 页 §8 / §13.6 的规则是**任何**契约形状变化都要提升它，
 * 并重新生成快照（Host 与 Core 总是一起发布，版本号只用来发现安装损坏或忘了重建 Core）。
 */
export { PROTOCOL_VERSION } from './version'

/** 方法或通知的 owner；查不到返回 undefined（05 页 §8）。 */
export function ownerOf(name: string): 'core' | 'host' | undefined {
  return appContract.methods.get(name)?.owner ?? appContract.notifications.get(name)?.owner
}
