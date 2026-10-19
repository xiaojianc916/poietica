import type { AssetHandler } from '@poietica/host-kernel'
import {
  INTELLIGENT_UI_LIBRARY_ORIGINS,
  INTELLIGENT_UI_MODEL_STATE_MAX,
  INTELLIGENT_UI_SHELL_FILE,
  INTELLIGENT_UI_VIEW_STATE_MAX,
} from '../contract'

/*
 * 智能界面的外壳文档：poietica-asset://intelligent-ui/shell.html。
 *
 * 为什么要一个外壳，而不是 <iframe srcdoc>：srcdoc / blob: / data: 文档**继承父文档的 CSP**，
 * 主窗口的 script-src 不给 'unsafe-inline'，界面里的脚本一行都跑不起来；放开主窗口的 CSP 又等于
 * 给整个应用开口子。外壳走资源协议，有自己的响应头，CSP 只管它自己。
 *
 * 流程：UI 的 iframe（sandbox="allow-scripts allow-forms"，不给 allow-same-origin）加载外壳 → iframe 的 load
 * 事件里 UI 发**一次** poietica:render { html, css, theme, bare, state }，并把一条 MessageChannel 的一端转交过来 →
 * 外壳 document.open() 之后、写入界面文档之前，用闭包里的这条端口装好小桥（window.poietica），再整页写入。
 *
 * 和旧版 show_widget 的区别（重构的地基部分）：
 * - 之后的往来只走这条私有端口。端口只在外壳的闭包里，界面代码拿不到，也就伪造不了小桥的话；UI 不再监听
 *   window 的 message，界面自己 parent.postMessage 什么都没用；
 * - send / draft / open 带「手势」：小桥在捕获阶段记下 isTrusted 的点击、按键、提交，每次真实操作只换一次，
 *   5 秒内有效，再叠加 navigator.userActivation。界面拿 setInterval 刷消息、开页就自动发，都换不到手势，
 *   UI 那一侧改成确认条（旧版靠「焦点在 iframe 上」判断，用户点过一次之后就一直成立）；
 * - 状态：poietica.state / setState({ model, view })。model 那一半随用户的下一句交给模型，view 只给界面自己恢复；
 * - 高度：不再封顶 80vh（卡片侧上限 10000px）；根节点不出滚动条；「宽度没变、内容涨的正好等于视口涨的」
 *   是 100vh 一类写法和 iframe 高度互相追，这一次不报。
 *
 * 小桥只用 ES5 + 少量 DOM API 写，开头先把要用的内建函数绑死：界面代码之后改了原型（例如
 * MessagePort.prototype.postMessage、Date.now），小桥照样用原版。
 *
 * 量高度不用 requestAnimationFrame：Chromium 会停掉不可见（零高、在视口外）的跨源 iframe 的渲染循环，
 * rAF 不来，第一次高度就永远报不上去。DOMContentLoaded / load 时直接量一次，之后交给 ResizeObserver。
 */

const LIBRARIES = INTELLIGENT_UI_LIBRARY_ORIGINS.join(' ')

export const INTELLIGENT_UI_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${LIBRARIES}`,
  `style-src 'unsafe-inline' ${LIBRARIES}`,
  `font-src data: ${LIBRARIES}`,
  'img-src data: blob:',
  'media-src data: blob:',
  `connect-src ${LIBRARIES}`,
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ')

/* 不论 bare 与否都带：根节点不出滚动条（高度交给卡片），量高时不被滚动条的宽度来回推。:where() 让界面能覆盖 */
const FRAME_CSS = ':where(html,body){overflow:hidden}'

/*
 * 预置样式：不写类名也像长在 Poietica 里；再加一小套可选的 iu-* 类（与契约里的 INTELLIGENT_UI_CLASS_NAMES 一一对应）。
 * 全部包在 :where() 里，特异性为零 —— 界面自己写的任何样式都压得过它。颜色、字体、圆角只用令牌（UI 求值后放进 #poietica-tokens）。
 */
const ELEMENT_CSS = `
*,*::before,*::after{box-sizing:border-box}
:where(html){font-family:var(--font-sans);font-size:var(--text-base);line-height:1.6;color:var(--color-text);background:transparent;-webkit-font-smoothing:antialiased;text-size-adjust:100%}
:where(body){margin:0}
:where(h1,h2,h3,h4){margin:1.1em 0 .5em;line-height:1.3;font-weight:600;color:var(--color-text)}
:where(h1){font-size:1.375em}:where(h2){font-size:1.15em}:where(h3){font-size:1em}:where(h4){font-size:.95em}
:where(h1,h2,h3,h4):first-child{margin-top:0}
:where(p,ul,ol){margin:.5em 0}
:where(a){color:var(--color-link);text-decoration:none}:where(a:hover){text-decoration:underline}
:where(small,figcaption){color:var(--color-text-muted);font-size:.875em}
:where(code,kbd,samp,pre){font-family:var(--font-mono);font-size:.9em}
:where(:not(pre)>code){background:var(--color-surface);border-radius:4px;padding:.1em .35em}
:where(pre){background:var(--color-surface);border-radius:var(--radius);padding:12px 14px;overflow:auto}
:where(hr){border:0;border-top:1px solid var(--color-border);margin:16px 0}
:where(button){font:inherit;font-size:.9375em;color:var(--color-text);background:var(--color-surface-raised);border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);height:32px;padding:0 12px;cursor:pointer;transition:background-color .12s,border-color .12s}
:where(button:hover){background:var(--color-hover)}
:where(button.primary,button[type=submit]){background:var(--color-accent);border-color:transparent;color:var(--color-accent-text)}
:where(button.primary:hover,button[type=submit]:hover){background:var(--color-accent);filter:brightness(1.06)}
:where(button:disabled){opacity:.5;cursor:default}
:where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file]),select,textarea){font:inherit;color:var(--color-text);background:var(--color-surface-raised);border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);min-height:32px;padding:5px 10px}
:where(textarea){min-height:72px;resize:vertical}
:where(input,textarea)::placeholder{color:var(--color-text-subtle)}
:where(input[type=checkbox],input[type=radio],input[type=range],progress,meter){accent-color:var(--color-accent)}
:where(button,input,select,textarea,a,[tabindex]):focus-visible{outline:2px solid var(--color-focus);outline-offset:1px}
:where(label){color:var(--color-text)}
:where(fieldset){border:1px solid var(--color-border);border-radius:var(--radius);padding:12px 14px;margin:0}
:where(legend){padding:0 4px;color:var(--color-text-muted)}
:where(table){border-collapse:collapse;width:100%;font-size:.95em;font-variant-numeric:tabular-nums}
:where(th,td){border-bottom:1px solid var(--color-border);padding:8px 10px;text-align:left;vertical-align:top}
:where(th){color:var(--color-text-muted);font-weight:600}
:where(svg){overflow:visible}
::selection{background:color-mix(in srgb,var(--color-accent) 28%,transparent)}
`

const CLASS_CSS = `
:where(.iu-stack){display:flex;flex-direction:column;gap:12px}
:where(.iu-row){display:flex;flex-wrap:wrap;align-items:center;gap:8px}
:where(.iu-grid){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(var(--iu-min,180px),100%),1fr));gap:12px}
:where(.iu-card){background:var(--color-surface-raised);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:14px 16px;min-width:0}
:where(.iu-card[aria-selected=true]){border-color:var(--color-accent);box-shadow:0 0 0 1px var(--color-accent)}
:where(.iu-muted){color:var(--color-text-muted);font-size:.875em}
:where(.iu-stat){display:flex;flex-direction:column;gap:2px;min-width:0}
:where(.iu-stat-label){color:var(--color-text-muted);font-size:.8125em}
:where(.iu-stat-value){font-size:1.6em;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
:where(.iu-badge){display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;font-size:.75em;font-weight:500;background:var(--color-surface);color:var(--color-text-muted);border:1px solid var(--color-border)}
:where(.iu-badge.iu-success){color:var(--color-success);border-color:color-mix(in srgb,var(--color-success) 40%,transparent)}
:where(.iu-badge.iu-warning){color:var(--color-warning);border-color:color-mix(in srgb,var(--color-warning) 40%,transparent)}
:where(.iu-badge.iu-danger){color:var(--color-danger);border-color:color-mix(in srgb,var(--color-danger) 40%,transparent)}
:where(.iu-tabs){display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--color-border);margin-bottom:12px}
:where(.iu-tabs>button){background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--color-text-muted);height:34px;padding:0 10px}
:where(.iu-tabs>button:hover){background:transparent;color:var(--color-text)}
:where(.iu-tabs>button[aria-selected=true]){color:var(--color-text);border-bottom-color:var(--color-accent)}
:where(.iu-controls){display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);align-items:center;gap:8px 14px}
:where(.iu-controls>label){color:var(--color-text-muted);font-size:.875em}
:where(button.iu-ghost){background:transparent;border-color:transparent}
:where(button.iu-ghost:hover){background:var(--color-hover)}
:where(button.iu-danger){color:var(--color-danger);border-color:color-mix(in srgb,var(--color-danger) 45%,transparent)}
:where([data-tooltip]){position:relative}
:where([data-tooltip]):hover::after,:where([data-tooltip]):focus-visible::after{content:attr(data-tooltip);position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);white-space:nowrap;z-index:10;pointer-events:none;padding:4px 8px;border-radius:var(--radius-sm);background:var(--color-text);color:var(--color-surface-raised);font-size:.75rem;line-height:1.4;box-shadow:var(--shadow-sm)}
`

export const BASE_CSS = ELEMENT_CSS + CLASS_CSS

/** 一次真实操作换到的手势在多久内有效：与 Chromium 的瞬时激活（transient activation）同为 5 秒 */
const GESTURE_MS = 5000

/*
 * 外壳脚本。小桥（install 里那一段）装在 document.open() 之后：open 会清掉 window 与 document 上已有的监听器，
 * 但同一个全局对象和外壳闭包都还在 —— window.poietica、捕获阶段的监听器、端口都在界面文档的脚本跑起来之前就位。
 */
const SHELL_JS = `(function(){'use strict';
var FRAME=${JSON.stringify(FRAME_CSS)},BASE=${JSON.stringify(BASE_CSS)},MODEL_MAX=${INTELLIGENT_UI_MODEL_STATE_MAX},VIEW_MAX=${INTELLIGENT_UI_VIEW_STATE_MAX},GESTURE_MS=${GESTURE_MS};
var now=Date.now.bind(Date),stringify=JSON.stringify.bind(JSON),parse=JSON.parse.bind(JSON),define=Object.defineProperty,freeze=Object.freeze;
var ua=navigator.userActivation,uaGet=ua?Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ua),'isActive'):null;
var active=uaGet&&uaGet.get?uaGet.get.bind(ua):function(){return true};
function themeOf(t){return t==='dark'?'dark':'light'}
function clean(css){return String(css||'').replace(/<\\//g,'')}
function head(m){return '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
+'<style id="poietica-frame">'+FRAME+'</style><style id="poietica-tokens">'+clean(m.css)+'</style>'
+(m.bare?'':'<style id="poietica-base">'+BASE+'</style>')}
function compose(m){var html=String(m.html||''),h=head(m),theme=themeOf(m.theme);
if(/^\\s*(<!--[\\s\\S]*?-->\\s*)*<(!doctype|html|head)\\b/i.test(html)){
html=html.replace(/<html\\b/i,function(t){return t+' data-theme="'+theme+'"'});
if(/<head\\b[^>]*>/i.test(html))return html.replace(/<head\\b[^>]*>/i,function(t){return t+h});
if(/<html\\b[^>]*>/i.test(html))return html.replace(/<html\\b[^>]*>/i,function(t){return t+'<head>'+h+'</head>'});
return html.replace(/<!doctype[^>]*>/i,function(t){return t+'<head>'+h+'</head>'})}
return '<!doctype html><html data-theme="'+theme+'" style="color-scheme:'+theme+'"><head>'+h+'</head><body>'+html+'</body></html>'}
function json(text){if(typeof text!=='string')return null;try{return parse(text)}catch(e){return null}}
function memory(){var m=new Map();return{get length(){return m.size},key:function(i){var k=Array.from(m.keys())[i];return k===undefined?null:k},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}
function install(port,m){
var post=port.postMessage.bind(port),theme=themeOf(m.theme),init=m.state||{};
var state={model:json(init.model),view:json(init.view)},credit=false,creditAt=0;
function paint(){var r=document.documentElement;if(!r)return;r.setAttribute('data-theme',theme);r.style.colorScheme=theme}
function grant(e){if(e.isTrusted){credit=true;creditAt=now()}}
['pointerdown','click','keydown','submit','input','change'].forEach(function(n){addEventListener(n,grant,true)});
function gesture(){var g=credit&&now()-creditAt<GESTURE_MS&&active();if(g)credit=false;return g}
function act(type,key,value){var msg={type:type,gesture:gesture()};msg[key]=String(value);post(msg)}
function copy(v){return v==null?null:parse(stringify(v))}
function text(v,max,name){if(v==null)return null;var t=stringify(v);if(typeof t!=='string')throw new TypeError('poietica.setState: '+name+' must be JSON-serializable');
if(t.length>max)throw new RangeError('poietica.setState: '+name+' is too large ('+t.length+' > '+max+' characters of JSON)');return t}
var api={send:function(t){act('send','text',t)},draft:function(t){act('draft','text',t)},open:function(u){act('open','url',u)},
setState:function(next){if(!next||typeof next!=='object')throw new TypeError('poietica.setState expects { model, view }');
var mt=text('model' in next?next.model:state.model,MODEL_MAX,'model'),vt=text('view' in next?next.view:state.view,VIEW_MAX,'view');
state={model:json(mt),view:json(vt)};post({type:'state',model:mt,view:vt})}};
define(api,'theme',{get:function(){return theme},enumerable:true});
define(api,'state',{get:function(){return freeze({model:copy(state.model),view:copy(state.view)})},enumerable:true});
define(window,'poietica',{value:freeze(api)});
['localStorage','sessionStorage'].forEach(function(name){var ok=false;try{ok=window[name]!=null}catch(e){}if(!ok){try{define(window,name,{value:memory(),configurable:true})}catch(e){}}});
port.onmessage=function(e){var d=e.data;if(!d||d.type!=='theme')return;theme=themeOf(d.theme);paint();var s=document.getElementById('poietica-tokens');if(s)s.textContent=clean(d.css);dispatchEvent(new CustomEvent('poietica:theme',{detail:{theme:theme}}))};
var last=-1,lastW=-1,lastVh=-1;
function measure(){var r=document.documentElement,b=document.body;if(!r)return;var h=r.getBoundingClientRect().height;if(b)h=Math.max(h,b.getBoundingClientRect().bottom+window.scrollY);h=Math.ceil(h);
if(h===last)return;var w=innerWidth,vh=innerHeight;
if(last>=0&&w===lastW&&vh!==lastVh&&h-last===vh-lastVh)return;
last=h;lastW=w;lastVh=vh;post({type:'height',height:h})}
var ro=new ResizeObserver(measure);
document.addEventListener('DOMContentLoaded',function(){if(document.body)ro.observe(document.body);measure()});
addEventListener('load',measure);
document.addEventListener('click',function(e){var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;if(!a||e.defaultPrevented)return;var href=a.getAttribute('href')||'';if(href.charAt(0)==='#'||/^javascript:/i.test(href))return;e.preventDefault();try{var u=new URL(href,document.baseURI);if(u.protocol==='http:'||u.protocol==='https:'||u.protocol==='mailto:')api.open(u.href)}catch(x){}});
function report(m){post({type:'error',message:String(m).slice(0,500)})}
addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName){report('资源加载失败：'+(e.target.src||e.target.href||e.target.tagName));return}report(e.message||e.error||'Script error')},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;report(r&&r.message?r.message:r)});
return function(){paint();var r=document.documentElement;if(r)ro.observe(r);if(document.body)ro.observe(document.body);measure()}}
function boot(e){var d=e.data,port=e.ports&&e.ports[0];
if(e.source!==parent||!d||d.type!=='poietica:render'||!port)return;
removeEventListener('message',boot);
document.open();
var settle=install(port,d);
document.write(compose(d));
settle();
document.close()}
addEventListener('message',boot);
})();`

export const INTELLIGENT_UI_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${SHELL_JS}</script></body></html>`

/** 资源协议处理器：只认外壳这一个文件 */
export function createShellHandler(): AssetHandler {
  return (segments) => {
    if (segments.length !== 1 || segments[0] !== INTELLIGENT_UI_SHELL_FILE) return new Response(null, { status: 404 })
    return new Response(INTELLIGENT_UI_SHELL_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': INTELLIGENT_UI_CSP,
        // 外壳是随应用版本变的代码，不是内容寻址的资产：不吃资源协议默认的 immutable（asset-protocol.ts）
        'Cache-Control': 'no-cache',
      },
    })
  }
}
