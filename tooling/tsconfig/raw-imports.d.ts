// 全仓唯一的 `?raw` 模块声明：`import text from './file?raw'` 把文件原样读成字符串（目前只有 intelligent-ui 的 Host 用它读随包的 UMD 库）。
// 通配符模块声明由 biome 插件 tooling/checks/wildcard-modules.grit 看着：只放行本文件与 css-imports.d.ts。

declare module '*?raw' {
  const text: string
  export default text
}
