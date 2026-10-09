// 由 apps/core/scripts/build.ts 在构建时通过 Bun.build 的 define 内联为 package.json 的 version。
// 运行时不读环境变量，因此不受 buildCoreLaunch 删除 POIETICA_* 的影响。
export const CORE_VERSION: string = process.env.POIETICA_BUILD_VERSION ?? '0.0.0-dev'
