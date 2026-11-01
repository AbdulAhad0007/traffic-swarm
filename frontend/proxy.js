import { NextResponse } from 'next/server';
import { getSiteConfig } from '@/lib/siteConfig';
import { firstEnabledRoute, moduleForRoute } from '@/lib/moduleRegistry';

// Server-side block for disabled modules: direct visits never reach a disabled page.
export async function proxy(request) {
  const { pathname } = request.nextUrl;
  const config = await getSiteConfig();

  if (pathname.startsWith('/osm/')) {
    if (config.modules['signal-map'].enabled) return NextResponse.next();
    return NextResponse.json({ error: 'module_disabled', detail: 'This feature is currently unavailable.' }, { status: 403 });
  }

  const mod = moduleForRoute(pathname);
  if (!mod || config.modules[mod.slug].enabled) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.search = '';
  if (pathname === '/') {
    const next = firstEnabledRoute(config);
    if (next) {
      url.pathname = next;
      return NextResponse.redirect(url, 307);
    }
  }
  url.pathname = '/unavailable';
  return NextResponse.rewrite(url, { headers: { 'Cache-Control': 'no-store' } });
}

export const config = {
  matcher: ['/', '/ghaziabad', '/live', '/demo', '/controllers', '/prediction', '/mixed', '/osm/:path*'],
};
