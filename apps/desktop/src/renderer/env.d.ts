// renderer 里会 import .css（只做副作用），需要通配符模块声明。
// 全仓只有一份这样的声明（@poietica/design-system/src/css.d.ts），这里用三斜线引用把它带进本包的程序图，
// 不再重复声明一份（多份通配符声明会让「哪个生效」取决于编译顺序）。
/// <reference path="../../../packages/design-system/src/css.d.ts" />
