// 全仓唯一的 CSS 模块声明：本仓 .css 只做副作用导入，没有 CSS Modules。
// 通配符声明全局只能有一份，由 biome 插件 tooling/checks/wildcard-modules.grit 看着（只放行本文件）。

declare module '*.css' {}
