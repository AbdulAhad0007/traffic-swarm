// Runs in <head> before first paint. Only slugs from THEMES can reach the page; anything else leaves the
// default tokens in place. The admin area keeps its own look.
import { THEMES } from './themes.js';

const fonts = Object.fromEntries(THEMES.map(t => [t.slug, t.fonts]));

export const themeBootScript = `(function(){try{
if(location.pathname==='/admin'||location.pathname.indexOf('/admin/')===0)return;
var m=document.cookie.match(/(?:^|; )tsi-theme=([^;]*)/);var t=m&&m[1];
var f=${JSON.stringify(fonts)};
if(!t||!Object.prototype.hasOwnProperty.call(f,t))return;
document.documentElement.setAttribute('data-theme',t);
if(f[t]){var l=document.createElement('link');l.rel='stylesheet';l.href=f[t];document.head.appendChild(l);}
}catch(e){}})();`;
