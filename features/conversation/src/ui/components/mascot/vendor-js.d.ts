/*
 * 吉祥物的运行时是随界面一起迁入的第三方 JS（features/conversation/vendor/aora-bot/emotion-ball/js）。
 *
 * 它们是**副作用导入**（往全局挂一个引擎），没有类型也不需要类型；四条声明逐条点名，
 * 不写宽松的 '*'（那样会把别的模块解析错误一起吞掉）。tsconfig 的 include 只覆盖 src，
 * 所以这里用模块声明而不是让 tsc 去编译那几个 .js。
 */
declare module '*/vendor/aora-bot/emotion-ball/js/rings.js' {}
declare module '*/vendor/aora-bot/emotion-ball/js/emotions.js' {}
declare module '*/vendor/aora-bot/emotion-ball/js/ball.js' {}
declare module '*/vendor/aora-bot/emotion-ball/js/engine.js' {}
