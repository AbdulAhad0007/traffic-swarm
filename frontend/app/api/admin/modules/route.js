import { denyUnlessAdmin, jsonError, noStore } from '@/lib/adminAuth';
import { rest } from '@/lib/supabaseRest';
import { MODULES } from '@/lib/moduleRegistry';

export async function GET(request) {
  const denied = await denyUnlessAdmin(request);
  if (denied) return denied;
  try {
    const [modules, sections] = await Promise.all([
      rest('site_modules?select=id,name,slug,identifier,is_enabled,sort_order,updated_at&order=sort_order'),
      rest('site_module_sections?select=id,module_id,name,slug,is_enabled,sort_order,updated_at&order=sort_order'),
    ]);
    // Only the registered modules are shown, in their registered order.
    const known = MODULES.flatMap(m => {
      const row = modules.find(r => r.slug === m.slug);
      return row ? [{ ...row, route: m.route, sections: sections.filter(s => s.module_id === row.id) }] : [];
    });
    return Response.json({ modules: known }, { headers: noStore });
  } catch (err) {
    console.error('Could not load modules:', err.message);
    return jsonError(503, 'service_unavailable');
  }
}
