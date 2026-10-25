import type { AssetHandler } from '@poietica/host-kernel'
import {
  INTELLIGENT_UI_ASSET_HOST,
  INTELLIGENT_UI_LIBRARIES,
  INTELLIGENT_UI_LIBRARY_ORIGINS,
  INTELLIGENT_UI_MODEL_STATE_MAX,
  INTELLIGENT_UI_SHELL_FILE,
  INTELLIGENT_UI_TWEAK_CONTROLS_MAX,
  INTELLIGENT_UI_TWEAK_GROUPS_MAX,
  INTELLIGENT_UI_TWEAK_OPTIONS_MAX,
  INTELLIGENT_UI_TWEAKS_STATE_MAX,
  INTELLIGENT_UI_VENDOR_SEGMENT,
  INTELLIGENT_UI_VIEW_STATE_MAX,
  intelligentUiLibraryUrls,
  intelligentUiVendorUrl,
} from '../contract'
import { vendorText } from './vendor'

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
 * 与早先 show_widget 那套做法的区别（本架构的地基）：
 * - 之后的往来只走这条私有端口。端口只在外壳的闭包里，界面代码拿不到，也就伪造不了小桥的话；UI 不再监听
 *   window 的 message，界面自己 parent.postMessage 什么都没用；
 * - send / draft / open 带「手势」：小桥在捕获阶段记下 isTrusted 的点击、按键、提交，每次真实操作只换一次，
 *   5 秒内有效，再叠加 navigator.userActivation。界面拿 setInterval 刷消息、开页就自动发，都换不到手势，
 *   UI 那一侧改成确认条（原先靠「焦点在 iframe 上」判断，用户点过一次之后就一直成立）；
 * - 状态：poietica.state / setState({ model, view })。model 那一半随用户的下一句交给模型，view 只给界面自己恢复；
 * - 高度：不再封顶 80vh（卡片侧上限 10000px）；根节点不出滚动条；「宽度没变、内容涨的正好等于视口涨的」
 *   是 100vh 一类写法和 iframe 高度互相追，这一次不报。
 *
 * 小桥只用 ES5 + 少量 DOM API 写，开头先把要用的内建函数绑死：界面代码之后改了原型（例如
 * MessagePort.prototype.postMessage、Date.now），小桥照样用原版。
 *
 * 量高度不用 requestAnimationFrame：Chromium 会停掉不可见（零高、在视口外）的跨源 iframe 的渲染循环，
 * rAF 不来，第一次高度就永远报不上去。DOMContentLoaded / load 时直接量一次，之后交给 ResizeObserver。
 *
 * 第二阶段加的四件事：
 * - 预览：render 带 `preview: true` 时不装小桥、不跑脚本，写一个 body 带 inert 的静态文档，把模型已经写出来的那部分
 *   html 去掉脚本、内联事件、可导航的东西之后放进去；之后端口上来的 `preview` 只换 body，`render` 才在同一个 iframe
 *   里换成真界面（document.open 会清掉预览期间的监听器，小桥只装一次）；
 * - 随包库：写入之前把指向随包库的精确 CDN 地址换成 poietica-asset://intelligent-ui/vendor/…（导出的独立文件里换成
 *   blob: 地址，由 render 的 `libraries` 给）；被换掉的那个 <script> 去掉 integrity / crossorigin / type=module
 *   —— 本地那一份字节不同、资源协议也不走 CORS；
 * - 调整面板：poietica.tweak 登记几组控件，经端口交给卡片画；卡片回送的值写进状态的 tweaks 那一份；
 * - 独立模式（standalone）：导出的 HTML 文件里由一段引导脚本自己发 render，根节点可以滚动、正文居中。
 */

const LIBRARIES = INTELLIGENT_UI_LIBRARY_ORIGINS.join(' ')

/** 随包库的来源：外壳同一个 host（CSP 的 host-source 不认路径以外的写法，整个 host 放行） */
const VENDOR_ORIGIN = `poietica-asset://${INTELLIGENT_UI_ASSET_HOST}`

export const INTELLIGENT_UI_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${VENDOR_ORIGIN} ${LIBRARIES}`,
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

/* 独立文件（导出）：是一整个浏览器窗口，要能滚动；正文居中、留边，底色跟主题走 */
const STANDALONE_CSS = ':where(html){background:Canvas}:where(body){margin:0 auto;padding:24px;max-width:880px}'
const STANDALONE_WIDE_CSS = ':where(html){background:Canvas}:where(body){margin:0;padding:24px}'

/* 预览里不要的东西：会执行、会导航、会请求子文档的元素一律拿掉（body 另有 inert，点不了、聚焦不了） */
const PREVIEW_DROP =
  'script,iframe,frame,frameset,object,embed,portal,base,meta,noscript,template,link:not([rel~=stylesheet])'

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
 * 随包库的地址表。哪些库真的被引用由 vendor.ts 的 librariesUsedBy 决定：只认 <script src> 的精确地址，
 * 注释/正文里出现的 URL 不算 —— 导出内嵌与外壳替换因此共用同一套语义。
 */
const VENDOR = INTELLIGENT_UI_LIBRARIES.map((library) => ({
  asset: library.asset,
  local: intelligentUiVendorUrl(library),
  urls: intelligentUiLibraryUrls(library),
}))

const LIMITS = {
  groups: INTELLIGENT_UI_TWEAK_GROUPS_MAX,
  controls: INTELLIGENT_UI_TWEAK_CONTROLS_MAX,
  options: INTELLIGENT_UI_TWEAK_OPTIONS_MAX,
}

/*
 * 外壳脚本。小桥（install 里那一段）装在 document.open() 之后：open 会清掉 window 与 document 上已有的监听器，
 * 但同一个全局对象和外壳闭包都还在 —— window.poietica、捕获阶段的监听器、端口都在界面文档的脚本跑起来之前就位。
 */
export const SHELL_JS = `(function(){'use strict';
var FRAME=${JSON.stringify(FRAME_CSS)},ALONE=${JSON.stringify(STANDALONE_CSS)},ALONE_WIDE=${JSON.stringify(STANDALONE_WIDE_CSS)},BASE=${JSON.stringify(BASE_CSS)},DROP=${JSON.stringify(PREVIEW_DROP)};
var MODEL_MAX=${INTELLIGENT_UI_MODEL_STATE_MAX},VIEW_MAX=${INTELLIGENT_UI_VIEW_STATE_MAX},TWEAKS_MAX=${INTELLIGENT_UI_TWEAKS_STATE_MAX},GESTURE_MS=${GESTURE_MS},VENDOR=${JSON.stringify(VENDOR)},LIMIT=${JSON.stringify(LIMITS)};
var now=Date.now.bind(Date),stringify=JSON.stringify.bind(JSON),parse=JSON.parse.bind(JSON),define=Object.defineProperty,freeze=Object.freeze,keys=Object.keys,isArray=Array.isArray,own=Function.prototype.call.bind(Object.prototype.hasOwnProperty),defer=setTimeout.bind(window);
var ua=navigator.userActivation,uaGet=ua?Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ua),'isActive'):null;
var active=uaGet&&uaGet.get?uaGet.get.bind(ua):function(){return true};
function themeOf(t){return t==='dark'?'dark':'light'}
function clean(css){return String(css||'').replace(/<\\//g,'')}
function frameCss(m){return m.standalone?(m.wide?ALONE_WIDE:ALONE):FRAME}
function head(m){return '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
+'<style id="poietica-frame">'+frameCss(m)+'</style><style id="poietica-tokens">'+clean(m.css)+'</style>'
+(m.bare?'':'<style id="poietica-base">'+BASE+'</style>')}
function libraries(m){var map={},given=m.libraries&&typeof m.libraries==='object'?m.libraries:{};
VENDOR.forEach(function(l){var to=typeof given[l.asset]==='string'?given[l.asset]:m.standalone?null:l.local;if(to)l.urls.forEach(function(u){map[u]=to})});return map}
function tagEnd(html,at){var q='',c;for(var i=at;i<html.length;i++){c=html.charAt(i);if(q){if(c===q)q=''}else if(c==='"'||c==="'")q=c;else if(c==='>')return i}return -1}
function scriptClose(html,from){var low=html.toLowerCase(),at=low.indexOf('</script',from);while(at>=0){var after=low.charAt(at+8);if(after===''||/\\s|\\//.test(after))return at;at=low.indexOf('</script',at+8)}return -1}
function vendor(html,m){var map=libraries(m),text=String(html||''),out='',last=0,pos=0;
while(pos<text.length){var open=text.indexOf('<',pos);if(open<0)break;
if(text.slice(open,open+4)==='<!--'){var commentEnd=text.indexOf('-->',open+4);if(commentEnd<0)break;pos=commentEnd+3;continue}
if(!/^<script(?=[\\s\\/>])/i.test(text.slice(open,open+8))){pos=open+1;continue}
var end=tagEnd(text,open);if(end<0)break;var tag=text.slice(open,end+1),hit=false;
var next=tag.replace(/(\\ssrc\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))/i,function(all,pre,d,q,u){var url=d!==undefined?d:q!==undefined?q:u;if(!own(map,url))return all;hit=true;return pre+'"'+map[url]+'"'});
if(hit){out+=text.slice(last,open)+next.replace(/\\s(integrity|crossorigin|type)(\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+))?/gi,'');last=end+1}
var close=scriptClose(text,end+1);if(close<0)break;pos=close+9}
return out+text.slice(last)}
function compose(m){var html=vendor(String(m.html||''),m),h=head(m),theme=themeOf(m.theme);
if(/^\\s*(<!--[\\s\\S]*?-->\\s*)*<(!doctype|html|head)\\b/i.test(html)){
html=html.replace(/<html\\b/i,function(t){return t+' data-theme="'+theme+'"'});
if(/<head\\b[^>]*>/i.test(html))return html.replace(/<head\\b[^>]*>/i,function(t){return t+h});
if(/<html\\b[^>]*>/i.test(html))return html.replace(/<html\\b[^>]*>/i,function(t){return t+'<head>'+h+'</head>'});
return html.replace(/<!doctype[^>]*>/i,function(t){return t+'<head>'+h+'</head>'})}
return '<!doctype html><html data-theme="'+theme+'" style="color-scheme:'+theme+'"><head>'+h+'</head><body>'+html+'</body></html>'}
function json(text){if(typeof text!=='string')return null;try{return parse(text)}catch(e){return null}}
function memory(){var m=new Map();return{get length(){return m.size},key:function(i){var k=Array.from(m.keys())[i];return k===undefined?null:k},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}
function paint(theme,css){var r=document.documentElement;if(r){r.setAttribute('data-theme',theme);r.style.colorScheme=theme}var s=document.getElementById('poietica-tokens');if(s&&css!==undefined)s.textContent=clean(css)}
function meter(post){var last=-1,lastW=-1,lastVh=-1;return function(){var r=document.documentElement,b=document.body;if(!r)return;var h=r.getBoundingClientRect().height;if(b)h=Math.max(h,b.getBoundingClientRect().bottom+window.scrollY);h=Math.ceil(h);
if(h===last)return;var w=innerWidth,vh=innerHeight;
if(last>=0&&w===lastW&&vh!==lastVh&&h-last===vh-lastVh)return;
last=h;lastW=w;lastVh=vh;post({type:'height',height:h})}}
var URL_ATTRS={href:1,src:1,action:1,formaction:1,poster:1,'xlink:href':1};
function trimUrl(v){return String(v==null?'':v).replace(/^[\\u0000-\\u0020]+|[\\u0000-\\u0020]+$/g,'')}
/* 统一小写再比对：javascript: / JaVaScRiPt: 一样拒；协议内的空白与实体由浏览器解析，这里只收明确的安全前缀 */
function safeUrl(v){var t=trimUrl(v).toLowerCase();return t.charAt(0)==='#'||/^(?:https?:|mailto:|data:image\\/(?:png|jpeg|gif|webp)(?:[;,]|$))/.test(t)}
function cssUrl(v){var t=trimUrl(v).toLowerCase();if((t.charAt(0)==='"'||t.charAt(0)==="'")&&t.charAt(t.length-1)===t.charAt(0))t=trimUrl(t.slice(1,-1));return /^data:image\\/(?:png|jpeg|gif|webp)(?:[;,]|$)/.test(t)}
function withoutImports(css){var text=String(css==null?'':css),low=text.toLowerCase(),out='',pos=0,next=low.indexOf('@import',pos);
while(next>=0){out+=text.slice(pos,next);var end=text.indexOf(';',next+7);if(end<0){pos=text.length;break}pos=end+1;next=low.indexOf('@import',pos)}
return out+text.slice(pos)}
function cleanCss(css){var text=withoutImports(css),low=text.toLowerCase(),out='',pos=0,next=low.indexOf('url(',pos);
while(next>=0){out+=text.slice(pos,next);var close=text.indexOf(')',next+4);if(close<0)return out+text.slice(next);
var raw=text.slice(next+4,close);if(cssUrl(raw))out+=text.slice(next,close+1);pos=close+1;next=low.indexOf('url(',pos)}
return out+text.slice(pos)}
function inert(html){var t=document.createElement('template');t.innerHTML=String(html||'');var c=t.content;
Array.prototype.forEach.call(c.querySelectorAll(DROP),function(n){n.remove()});
Array.prototype.forEach.call(c.querySelectorAll('style'),function(n){n.textContent=cleanCss(n.textContent)});
Array.prototype.forEach.call(c.querySelectorAll('*'),function(n){for(var i=n.attributes.length-1;i>=0;i--){var a=n.attributes[i],name=a.name.toLowerCase();
if(name.slice(0,2)==='on'||name==='autofocus'||name==='autoplay'||name==='srcdoc'){n.removeAttribute(a.name);continue}
if(own(URL_ATTRS,name)&&!safeUrl(a.value)){n.removeAttribute(a.name);continue}
if(name==='style'){var css=cleanCss(a.value);if(css==='')n.removeAttribute(a.name);else n.setAttribute(a.name,css)}}});
return c}
function preview(port,m){var post=port.postMessage.bind(port),measure=meter(post),theme=themeOf(m.theme);
document.open();document.write('<!doctype html><html data-theme="'+theme+'" style="color-scheme:'+theme+'"><head>'+head(m)+'</head><body inert></body></html>');document.close();
var ro=new ResizeObserver(measure);
function show(html){if(document.body)document.body.replaceChildren(inert(html));measure()}
show(m.html);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);
port.onmessage=function(e){var d=e.data;if(!d)return;
if(d.type==='preview'){show(d.html);return}
if(d.type==='theme'){paint(themeOf(d.theme),d.css);return}
if(d.type==='render'){ro.disconnect();port.onmessage=null;live(port,d)}}}
function control(c,taken){if(!c||typeof c!=='object')throw new TypeError('poietica.tweak: each control must be an object');
var key=String(c.key==null?'':c.key),label=String(c.label==null?key:c.label).slice(0,60),type=c.type,v;
if(!/^[A-Za-z0-9_.-]{1,40}$/.test(key))throw new TypeError('poietica.tweak: control key must be 1-40 letters, digits, _ . or -');
if(own(taken,key))throw new TypeError('poietica.tweak: duplicate control key "'+key+'"');taken[key]=true;
if(type==='range'){var min=Number(c.min),max=Number(c.max),step=c.step==null?1:Number(c.step);
if(!(isFinite(min)&&isFinite(max)&&max>min&&isFinite(step)&&step>0))throw new TypeError('poietica.tweak: range "'+key+'" needs numbers min < max and step > 0');
v=Number(c.value);return{key:key,label:label,type:type,min:min,max:max,step:step,unit:c.unit==null?'':String(c.unit).slice(0,8),value:isFinite(v)?Math.min(max,Math.max(min,v)):min}}
if(type==='color')return{key:key,label:label,type:type,value:typeof c.value==='string'&&/^#[0-9a-f]{6}$/i.test(c.value)?c.value.toLowerCase():'#000000'};
if(type==='toggle')return{key:key,label:label,type:type,value:c.value===true};
if(type==='select'){var list=isArray(c.options)?c.options:[];
if(list.length===0||list.length>LIMIT.options)throw new RangeError('poietica.tweak: select "'+key+'" needs 1-'+LIMIT.options+' options');
var options=list.map(function(o){var bag=o&&typeof o==='object',value=String(bag?o.value:o).slice(0,100);return{value:value,label:String(bag&&o.label!=null?o.label:value).slice(0,60)}});
v=String(c.value);return{key:key,label:label,type:type,options:options,value:options.some(function(o){return o.value===v})?v:options[0].value}}
throw new TypeError('poietica.tweak: control type must be range, color, toggle or select')}
function coerce(c,v){if(c.type==='range')return typeof v==='number'&&isFinite(v)?Math.min(c.max,Math.max(c.min,v)):c.value
if(c.type==='color')return typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v.toLowerCase():c.value;
if(c.type==='toggle')return v===true||v===false?v:c.value;
for(var i=0;i<c.options.length;i++)if(c.options[i].value===String(v))return c.options[i].value;return c.value}
function install(port,m){
var post=port.postMessage.bind(port),theme=themeOf(m.theme),init=m.state||{};
var state={model:json(init.model),view:json(init.view)},texts={model:typeof init.model==='string'?init.model:null,view:typeof init.view==='string'?init.view:null,tweaks:typeof init.tweaks==='string'?init.tweaks:null};
var saved=json(texts.tweaks);if(!saved||typeof saved!=='object'||isArray(saved))saved={};
var groups={},byId={},seq=0,credit=false,creditAt=0;
function grant(e){if(e.isTrusted){credit=true;creditAt=now()}}
['pointerdown','click','keydown','submit','input','change'].forEach(function(n){addEventListener(n,grant,true)});
/* Esc 出不了 iframe：派发完了界面也没 preventDefault（它自己的弹层没拦），才转告卡片（展开的对话框靠它关闭） */
addEventListener('keydown',function(e){if(e.key!=='Escape'||!e.isTrusted||e.isComposing)return;defer(function(){if(!e.defaultPrevented)post({type:'escape'})},0)});
function gesture(){var g=credit&&now()-creditAt<GESTURE_MS&&active();if(g)credit=false;return g}
function act(type,key,value){var msg={type:type,gesture:gesture()};msg[key]=String(value);post(msg)}
function copy(v){return v==null?null:parse(stringify(v))}
function text(v,max,name){if(v==null)return null;var t=stringify(v);if(typeof t!=='string')throw new TypeError('poietica.setState: '+name+' must be JSON-serializable');
if(t.length>max)throw new RangeError('poietica.setState: '+name+' is too large ('+t.length+' > '+max+' characters of JSON)');return t}
function report(m){post({type:'error',message:String(m).slice(0,500)})}
function publish(){post({type:'state',model:texts.model,view:texts.view,tweaks:texts.tweaks})}
function persistTweaks(){var out={};keys(saved).forEach(function(l){if(!own(groups,l))out[l]=saved[l]});
keys(groups).forEach(function(l){var g=groups[l],diff={},any=false;g.controls.forEach(function(c){if(g.values[c.key]!==c.value){diff[c.key]=g.values[c.key];any=true}});if(any)out[l]=diff});
var t=keys(out).length===0?(texts.tweaks===null?null:'{}'):stringify(out);if(t!==null&&t.length>TWEAKS_MAX){report('poietica.tweak: tweak values are too large to keep');return}
saved=out;texts.tweaks=t;publish()}
function notify(g){if(!g.onChange)return;try{g.onChange(copy(g.values))}catch(e){report(e&&e.message?e.message:e)}}
function tweak(spec){if(!spec||typeof spec!=='object')throw new TypeError('poietica.tweak expects { label, controls, onChange }');
var label=String(spec.label==null?'':spec.label).slice(0,60);if(label==='')throw new TypeError('poietica.tweak: label is required');
if(own(groups,label))throw new TypeError('poietica.tweak: a group labelled "'+label+'" is already registered');
if(keys(groups).length>=LIMIT.groups)throw new RangeError('poietica.tweak: at most '+LIMIT.groups+' groups per view');
var list=isArray(spec.controls)?spec.controls:[];if(list.length===0||list.length>LIMIT.controls)throw new RangeError('poietica.tweak: a group needs 1-'+LIMIT.controls+' controls');
var taken={},controls=list.map(function(c){return control(c,taken)}),before=own(saved,label)&&saved[label]&&typeof saved[label]==='object'?saved[label]:{},values={},restored=false;
controls.forEach(function(c){values[c.key]=own(before,c.key)?coerce(c,before[c.key]):c.value;if(values[c.key]!==c.value)restored=true});
var g={id:++seq,label:label,controls:controls,values:values,onChange:typeof spec.onChange==='function'?spec.onChange:null};groups[label]=g;byId[g.id]=g;
post({type:'tweak',op:'register',id:g.id,label:label,controls:controls,values:copy(values)});
if(restored)Promise.resolve().then(function(){if(byId[g.id]===g)notify(g)});
return freeze({get values(){return copy(g.values)},dispose:function(){if(byId[g.id]!==g)return;delete byId[g.id];delete groups[label];post({type:'tweak',op:'dispose',id:g.id})}})}
function tweaked(d){var g=byId[d.id];if(!g||!d.values||typeof d.values!=='object')return;
g.controls.forEach(function(c){if(own(d.values,c.key))g.values[c.key]=coerce(c,d.values[c.key])});persistTweaks();notify(g)}
var api={send:function(t){act('send','text',t)},draft:function(t){act('draft','text',t)},open:function(u){act('open','url',u)},
setState:function(next){if(!next||typeof next!=='object')throw new TypeError('poietica.setState expects { model, view }');
var mt=text('model' in next?next.model:state.model,MODEL_MAX,'model'),vt=text('view' in next?next.view:state.view,VIEW_MAX,'view');
state={model:json(mt),view:json(vt)};texts.model=mt;texts.view=vt;publish()},tweak:tweak};
define(api,'theme',{get:function(){return theme},enumerable:true});
define(api,'state',{get:function(){return freeze({model:copy(state.model),view:copy(state.view)})},enumerable:true});
define(window,'poietica',{value:freeze(api)});
['localStorage','sessionStorage'].forEach(function(name){var ok=false;try{ok=window[name]!=null}catch(e){}if(!ok){try{define(window,name,{value:memory(),configurable:true})}catch(e){}}});
port.onmessage=function(e){var d=e.data;if(!d)return;
if(d.type==='tweak.values'){tweaked(d);return}
if(d.type!=='theme')return;theme=themeOf(d.theme);paint(theme,d.css);dispatchEvent(new CustomEvent('poietica:theme',{detail:{theme:theme}}))};
var measure=meter(post),ro=new ResizeObserver(measure);
document.addEventListener('DOMContentLoaded',function(){if(document.body)ro.observe(document.body);measure()});
addEventListener('load',measure);
document.addEventListener('click',function(e){var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;if(!a||e.defaultPrevented)return;var href=a.getAttribute('href')||'';if(href.charAt(0)==='#'||/^javascript:/i.test(href))return;e.preventDefault();try{var u=new URL(href,document.baseURI);if(u.protocol==='http:'||u.protocol==='https:'||u.protocol==='mailto:')api.open(u.href)}catch(x){}});
addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName){report('资源加载失败：'+(e.target.src||e.target.href||e.target.tagName));return}report(e.message||e.error||'Script error')},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;report(r&&r.message?r.message:r)});
return function(){paint(theme);var r=document.documentElement;if(r)ro.observe(r);if(document.body)ro.observe(document.body);measure()}}
function live(port,d){document.open();var settle=install(port,d);document.write(compose(d));settle();document.close();
if(d.standalone&&!document.title&&typeof d.title==='string')document.title=d.title}
function boot(e){var d=e.data,port=e.ports&&e.ports[0];
if(e.source!==parent||!d||d.type!=='poietica:render'||!port)return;
removeEventListener('message',boot);
if(d.preview)preview(port,d);else live(port,d)}
addEventListener('message',boot);
})();`

export const INTELLIGENT_UI_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${SHELL_JS}</script></body></html>`

/**
 * 资源协议处理器：外壳文档，加上 vendor/ 下的随包库。
 * 库的文件名带着版本（contract 的 INTELLIGENT_UI_LIBRARIES），同名永远同字节，吃资源协议默认的 immutable。
 * 外壳的来源是不透明源（sandbox 没给 allow-same-origin）：classic <script> 不要 CORS，ACAO 只是给模块写法留条路。
 */
export function createShellHandler(): AssetHandler {
  return (segments) => {
    if (segments.length === 1 && segments[0] === INTELLIGENT_UI_SHELL_FILE) {
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
    const text =
      segments.length === 2 && segments[0] === INTELLIGENT_UI_VENDOR_SEGMENT ? vendorText(segments[1] ?? '') : null
    if (text === null) return new Response(null, { status: 404 })
    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
}
