// In-memory stand-ins so tests never touch production: the subset of Supabase's REST API the app uses,
// seeded from the registry, plus an upstream that records what the proxies forward.
import { createServer } from 'node:http';
import { MODULES } from '../../lib/moduleRegistry.js';

const read = req => new Promise(resolve => {
  let s = '';
  req.on('data', c => { s += c; });
  req.on('end', () => resolve(s));
});

export function seedTables() {
  const now = new Date(0).toISOString();
  let sectionId = 0;
  return {
    site_modules: MODULES.map((m, i) => ({ id: i + 1, name: m.name, slug: m.slug, identifier: m.identifier, is_enabled: true, sort_order: i + 1, updated_at: now })),
    site_module_sections: MODULES.flatMap((m, i) => m.sections.map(([slug, name], j) => ({
      id: ++sectionId, module_id: i + 1, name, slug, is_enabled: true, sort_order: j + 1, updated_at: now,
    }))),
    site_settings: [{ id: 1, theme: 'midnight', updated_at: now }],
    admin_sessions: [],
    admin_login_attempts: [],
  };
}

function matches(row, params) {
  for (const [col, cond] of params) {
    if (col === 'select' || col === 'order') continue;
    const dot = cond.indexOf('.');
    const op = cond.slice(0, dot), value = cond.slice(dot + 1);
    if (op === 'eq' && String(row[col]) !== value) return false;
    if (op === 'gt' && !(Date.parse(row[col]) > Date.parse(value))) return false;
    if (op === 'lt' && !(Date.parse(row[col]) < Date.parse(value))) return false;
  }
  return true;
}

export function startFakeSupabase(port, serviceKey) {
  const state = { tables: seedTables(), down: false };
  const server = createServer(async (req, res) => {
    const body = await read(req);
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (state.down) return send(500, { message: 'down' });
    if (req.headers.apikey !== serviceKey) return send(401, { message: 'bad key' });
    const url = new URL(req.url, 'http://x');
    const table = state.tables[url.pathname.replace('/rest/v1/', '')];
    if (!table) return send(404, { message: 'no table' });
    const name = url.pathname.replace('/rest/v1/', '');
    const params = [...url.searchParams.entries()];
    if (req.method === 'GET') return send(200, table.filter(r => matches(r, params)));
    if (req.method === 'DELETE') { state.tables[name] = table.filter(r => !matches(r, params)); return send(204); }
    if (req.method === 'PATCH') {
      const rows = table.filter(r => matches(r, params));
      rows.forEach(r => Object.assign(r, JSON.parse(body), { updated_at: new Date().toISOString() }));
      return send(200, rows);
    }
    if (req.method === 'POST') {
      const row = JSON.parse(body);
      const key = name === 'admin_sessions' ? 'token_hash' : 'key_hash';
      const existing = table.find(r => r[key] === row[key]);
      if (existing) Object.assign(existing, row); else table.push(row);
      return send(201);
    }
    return send(405);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ state, close: () => server.close() })));
}

export function startRecordingUpstream(port) {
  const hits = [];
  const server = createServer(async (req, res) => {
    await read(req);
    hits.push({ method: req.method, url: req.url, gateway: req.headers['x-tsi-gateway-secret'], role: req.headers['x-tsi-role'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"upstream":true}');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ hits, close: () => server.close() })));
}
