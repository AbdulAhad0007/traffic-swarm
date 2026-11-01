import { NextResponse } from 'next/server';
import { getSiteConfig } from '@/lib/siteConfig';
import { firstEnabledRoute, moduleForRoute } from '@/lib/moduleRegistry';

const THEME_COOKIE = 'tsi-theme';

// The cookie carries the saved theme to the inline script in app/layout.js, which applies it before first
// paint. Not HttpOnly because that script reads it; it holds only a public theme name.
function withTheme(request, response, theme) {
  if (request.cookies.get(THEME_COOKIE)?.value !== theme) {
    response.cookies.set(THEME_COOKIE, theme, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }
  return response;
}

// Server-side block for disabled modules: direct visits never reach a disabled page.
export async function proxy(request) {
  const { pathname } = request.nextUrl;
  const config = await getSiteConfig();

  if (pathname.startsWith('/osm/')) {
    if (config.modules['signal-map'].enabled) return NextResponse.next();
    return NextResponse.json({ error: 'module_disabled', detail: 'This feature is currently unavailable.' }, { status: 403 });
  }

  const themed = response => withTheme(request, response, config.theme);
  const mod = moduleForRoute(pathname);
  if (!mod || config.modules[mod.slug].enabled) return themed(NextResponse.next());

  const url = request.nextUrl.clone();
  url.search = '';
  if (pathname === '/') {
    const next = firstEnabledRoute(config);
    if (next) {
      url.pathname = next;
      return themed(NextResponse.redirect(url, 307));
    }
  }
  url.pathname = '/unavailable';
  return themed(NextResponse.rewrite(url, { headers: { 'Cache-Control': 'no-store' } }));
}

export const config = {
  matcher: ['/', '/ghaziabad', '/live', '/demo', '/controllers', '/prediction', '/mixed', '/unavailable', '/osm/:path*'],
};
