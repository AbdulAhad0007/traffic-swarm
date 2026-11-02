# Admin Panel: Deployment Guide

Follow these steps in order. Until step 4 is done, the public site stays fully on and `/admin` cannot be used.

## 1. Change the database password (do this first)
The old password was committed in `application.properties` and the repository is publicly readable. Removing it from the file does not remove it from Git history, so changing it is the real fix.

1. In Supabase: **Project Settings → Database → Reset database password**.
2. On Render, set these on the backend service:
   - `DB_URL`: the pooler JDBC URL, if the default is not right for you
   - `DB_USER`
   - `DB_PASSWORD`: the new password

**Set these before deploying this code.** The committed username and password defaults are gone, so the backend will not start without them.

3. Update any other place that uses the password, such as `POSTGRES_*` values in Vercel and your local `.env`.

## 2. Generate the admin password hash
```
node frontend/scripts/hash-admin-password.mjs
```
Type a password of at least 12 characters. Copy the printed `ADMIN_PASSWORD_HASH` value. To change the password later, repeat this step and update the variable.

## 3. Set environment variables

| Variable | Where | Required | Purpose |
|---|---|---|---|
| `ADMIN_USERNAME` | Vercel | Yes | Admin login name |
| `ADMIN_PASSWORD_HASH` | Vercel | Yes | From step 2 |
| `SUPABASE_URL` | Vercel | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Yes | Server-only database access |
| `LAB_URL` | Vercel | Yes for lab features | Public URL of the Lab API. It defaults to `localhost:8090`, which cannot work on Vercel |
| `BACKEND_URL` | Vercel | Yes | Render backend URL |
| `TSI_GATEWAY_SECRET` | Vercel, Render, Lab API | Recommended | Same long random value on all three. Blocks direct calls that would skip module rules |
| `DB_USER`, `DB_PASSWORD` | Render | Yes | Now have no default |

- Never prefix the admin or service role variables with `NEXT_PUBLIC_`.
- For local development, put the Vercel variables in `frontend/.env.local`, because Next.js does not read the root `.env`.
- Set `TSI_GATEWAY_SECRET` on Vercel and the backends in the same deployment window. If only the backends have it, the website's calls to them are refused. When unset, the checks are off.

## 4. Apply the database migration
In the Supabase dashboard, open **SQL Editor**, paste the contents of `db/migrations/001_admin_panel.sql`, and run it. Then do the same with `db/migrations/002_site_theme.sql`. Until `002` is applied, the site stays on Midnight Command, module toggles keep working, and the admin Theme section shows an error.

It creates `site_modules`, `site_module_sections`, `admin_sessions` and `admin_login_attempts`, enables row-level security, and seeds 8 modules and 64 sections, all ON. Visitors see no change. It is safe to re-run: it never overwrites a saved toggle or creates duplicates.

To verify:
```sql
select (select count(*) from site_modules) as modules,
       (select count(*) from site_module_sections) as sections;  -- expect 8 and 64
```

### 3D View module
Run `db/migrations/003_view_3d_module.sql` the same way, **before deploying the code that includes it**. A registered module with no database row counts as enabled, so deploying first would publish 3D View with no working toggle. The migration adds module 9 and 10 sections, and the module starts off.

Run `db/migrations/005_live_camera_module.sql` the same way, also before deploying. It adds module 10 (Live Camera), switched off, with 16 sections and the `lcm_*` tables. **Public video previews** starts off and stays off even without a database row, so camera video is never shown to visitors until an administrator turns it on. Setting up the camera service: "Live Camera" in `README.md`.

After deploying, restart the Lab API so it serves the new `network3d` and `frames` endpoints. Runs recorded before that have no vehicle data. New Lab runs record about 30 KB per simulated second at 500 vehicles, capped at 200 MB per run; set `TSI_LAB_CAPTURE_FRAMES=0` on the Lab API to turn recording off.

## 5. Deploy
Deploy in this order: Render backend, then the Lab API, then Vercel.

## 6. Smoke test
1. Open `/admin` and sign in.
2. Turn off a low-risk section, such as Signal Map → Map legend.
3. Reload `/ghaziabad` and confirm the legend is gone. Allow up to 5 seconds per server instance.
4. Turn it back on and sign out.

## Rollback
Redeploy the previous Vercel build. The new tables do not affect older code. For the backend, the old build's committed password stops working after step 1, so keep the Render variables set.

## Running the tests
```
cd frontend && npm run build && npm test     # uses fake local services, never production
python -m pytest -q                          # from the repository root
cd backend && ./mvnw test
```

## Adding a section later
1. Add it to `frontend/lib/moduleRegistry.js`.
2. Add its seed row in a new migration using `on conflict do nothing`.
3. Wrap the UI in `on('slug')`.
4. Add any endpoint it uses to `frontend/lib/labGuard.js`. Unlisted endpoints are refused.

## Known limits
- Hiding is not secrecy: a disabled module's client code stays in public JavaScript files.
- Signal Map calls Overpass and Nominatim directly from the browser, and Prediction and Mixed Traffic run wholly in the browser. For these, the toggles control pages and UI.
- Turning off a module does not stop SUMO jobs already running.
- During a Supabase outage, the public site uses its last known settings, or treats modules as on if an instance has none. Admin access stays locked.
- Login throttling is not atomic, so simultaneous attempts could slightly exceed the limit of five.
