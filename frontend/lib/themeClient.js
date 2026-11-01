// Browser side of theming: applying a theme, and giving canvas and map code the resolved token values.
import { useEffect, useState } from 'react';
import { THEMES, isThemeSlug, normalizeTheme } from './themes.js';

const CHANGE_EVENT = 'tsi-theme-change';

export function themeFromCookie(cookie) {
  const value = cookie.match(/(?:^|; )tsi-theme=([^;]*)/)?.[1];
  return isThemeSlug(value) ? value : null;
}

export function loadThemeFonts(slug) {
  const href = THEMES.find(t => t.slug === slug)?.fonts;
  if (!href || document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

export function applyTheme(value) {
  const slug = normalizeTheme(value);
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === slug) return;
  // A page with no attribute is already showing midnight, so applying it there changes nothing visible.
  loadThemeFonts(slug);
  root.setAttribute('data-theme', slug);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export const readToken = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Resolved values for code that cannot use var(): canvas drawing and map tile choice. Empty until mounted.
export function useThemeTokens(names) {
  const key = names.join('|');
  const [tokens, setTokens] = useState({});
  useEffect(() => {
    const list = key.split('|');
    const update = () => setTokens(Object.fromEntries(list.map(n => [n, readToken(n)])));
    update();
    window.addEventListener(CHANGE_EVENT, update);
    return () => window.removeEventListener(CHANGE_EVENT, update);
  }, [key]);
  return tokens;
}
