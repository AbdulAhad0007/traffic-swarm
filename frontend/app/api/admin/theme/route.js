import { denyUnlessAdmin, jsonError, noStore } from '@/lib/adminAuth';
import { rest } from '@/lib/supabaseRest';
import { invalidateSiteConfig } from '@/lib/siteConfig';
import { isThemeSlug, normalizeTheme } from '@/lib/themes';

export async function GET(request) {
  const denied = await denyUnlessAdmin(request);
  if (denied) return denied;
  try {
    const [row] = await rest('site_settings?select=theme&id=eq.1');
    if (!row) return jsonError(503, 'service_unavailable');
    return Response.json({ theme: normalizeTheme(row.theme) }, { headers: noStore });
  } catch (err) {
    console.error('Could not read theme:', err.message);
    return jsonError(503, 'service_unavailable');
  }
}

export async function PATCH(request) {
  const denied = await denyUnlessAdmin(request, { write: true });
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  if (!isThemeSlug(body?.theme)) return jsonError(400, 'invalid_theme');
  try {
    const [row] = await rest('site_settings?id=eq.1', {
      method: 'PATCH', prefer: 'return=representation', body: { theme: body.theme },
    });
    if (!row) return jsonError(503, 'service_unavailable');
    invalidateSiteConfig();
    return Response.json({ theme: row.theme, updated_at: row.updated_at }, { headers: noStore });
  } catch (err) {
    console.error('Could not update theme:', err.message);
    return jsonError(503, 'service_unavailable');
  }
}
