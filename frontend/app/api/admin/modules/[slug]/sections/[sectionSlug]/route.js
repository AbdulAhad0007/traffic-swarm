import { denyUnlessAdmin, jsonError, noStore } from '@/lib/adminAuth';
import { rest } from '@/lib/supabaseRest';
import { hasSection } from '@/lib/moduleRegistry';
import { invalidateSiteConfig } from '@/lib/siteConfig';

export async function PATCH(request, { params }) {
  const denied = await denyUnlessAdmin(request, { write: true });
  if (denied) return denied;
  const { slug, sectionSlug } = await params;
  if (!hasSection(slug, sectionSlug)) return jsonError(404, 'section_not_found');
  const body = await request.json().catch(() => null);
  if (typeof body?.is_enabled !== 'boolean') return jsonError(400, 'is_enabled_must_be_boolean');
  try {
    const [mod] = await rest(`site_modules?slug=eq.${slug}&select=id`);
    if (!mod) return jsonError(404, 'section_not_found');
    const [row] = await rest(`site_module_sections?module_id=eq.${mod.id}&slug=eq.${sectionSlug}`, {
      method: 'PATCH', prefer: 'return=representation', body: { is_enabled: body.is_enabled },
    });
    if (!row) return jsonError(404, 'section_not_found');
    invalidateSiteConfig();
    return Response.json(row, { headers: noStore });
  } catch (err) {
    console.error('Could not update section:', err.message);
    return jsonError(503, 'service_unavailable');
  }
}
