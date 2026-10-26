/** Windows Core 的必需产物——构建与发布校验共用，不能从「实际生成了什么」反推。 */
export const CORE_NATIVE_ARTIFACTS = ['pi_natives.win32-x64-modern.node', 'pi_natives.win32-x64-baseline.node'] as const
export const CORE_ARTIFACTS = ['poietica-core.exe', ...CORE_NATIVE_ARTIFACTS] as const
