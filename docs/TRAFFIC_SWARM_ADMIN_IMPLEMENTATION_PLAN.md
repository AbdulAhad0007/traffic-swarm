# Traffic Swarm Intelligence: Admin Panel Audit and Implementation Plan

**Status:** Implemented in the working tree, not yet deployed. See `docs/ADMIN_PANEL_DEPLOYMENT.md`. This plan records the Phase 1 audit.

**Differences from this plan as built:**
- `jobs/{id}/live` is also open to the fuel, emergency, calls and KPI sections, because those panels render only when live data has loaded.
- `osm-areas` POST is decided by Live Lab's `real-world-areas`. The Signal Map button additionally requires it in the UI.
- `proxy.js` does not check admin sessions. `/admin` and every admin API validate the session themselves.
- Confirmation is shown only when turning a module off.
- Polling hooks are not paused per section. They stop when a module is off, and a 403 is handled quietly.
- Automated tests use a fake Supabase REST API. The migration was checked separately on an in-process Postgres.

**Audited at:** commit `35c347b`, branch `main`, 2026-10-31.

**How this was checked**
- Read from source: all frontend routes, the module components, both API proxies, the Lab API, the Spring Boot controllers and services, the optimizer API, the schema, and configuration.
- `.env` values were not read, except the host of `BACKEND_URL`.
- Not checked: the live Supabase schema, Vercel and Render environment variables, and the running application. No services were started and no tests were run.

---

## 1. Findings that change the brief

| Brief assumes | What the code shows | Effect on the plan |
|---|---|---|
| MySQL | **Supabase PostgreSQL.** `pom.xml` has only the PostgreSQL driver, `schema.sql` uses `JSONB` and `gen_random_uuid()`, and `docker-compose.yml` says MySQL was replaced. `README.md` and `backend/.env.example` are out of date. | Tables go in Postgres. |
| React dashboard | **Next.js 16.4.3 App Router, React 19, JavaScript.** `cacheComponents` and `partialPrefetching` are on. | Use `proxy.js` (`middleware` is deprecated). Client-side route state survives navigation, so a client gate is also needed. |
| Existing authentication may exist | **There is none** in any of the three services. | Build a small dedicated admin login. |
| All 8 modules have routes | **How It Works has no route.** It is a modal opened from `Sidebar.js:183` and `OsmSignalMap.js:968`. | Disabling it removes both entry points. Direct-route tests do not apply. |
| Modules use public APIs | **Prediction and Mixed Traffic call no API.** Signal Map calls Overpass and Nominatim directly from the browser. | The server can block their pages, but has no API of its own to block. See section 8.2. |
| Prediction UI shows the prediction system | **It does not.** `PredictionDashboard.js` generates sine-wave data and hard-codes values. See section 9.3. | The toggles work the same way, but do not treat this as a real integration. |

---

## 2. Existing architecture

```
Browser
  └─ Next.js 16 (Vercel project "traffic-swarm", frontend/)
       ├─ Pages: / /ghaziabad /live /demo /controllers /prediction /mixed
       ├─ /api/lab/[...path]    (GET, POST) → FastAPI Lab API, LAB_URL, default localhost:8090
       └─ /api/proxy/[...path]  (GET, POST) → Spring Boot, BACKEND_URL (Render)

FastAPI Lab API (experiments/lab/api.py)
  └─ JobManager → worker subprocesses → SUMO/TraCI → simulation/ → files in experiments/lab/jobs and experiments/runs

Spring Boot 3.5.5, Java 21 (backend/)
  └─ /api/health, /api/experiments → JdbcTemplate → Supabase Postgres, table: experiments

Optimizer FastAPI (optimizer/app/main.py, port 8001)
  └─ /health, /api/swarm/{blackboard,observe,topology,optimize}. The frontend never calls it.
     Simulation code and tests import the engine in-process.
```

**Details that affect this work**
- The only table in the repository is `experiments`. `spring.sql.init.mode=always` re-runs `schema.sql` at each backend start, with `continue-on-error=true`.
- All public browser traffic to the Lab API and Spring Boot goes through the two Next.js proxy routes, so they are the natural enforcement point.
- Next.js has no Postgres or Supabase client dependency today. `lucide-react`, `recharts` and `leaflet` are the only additions to Next and React.
- Next.js loads environment files only from `frontend/`. The root `.env` is not read by it, so local development needs `frontend/.env.local`.
- Styling is plain CSS with tokens in `app/globals.css`. Components are JavaScript, with no test framework in `frontend/`. Python tests run through `pytest.ini`, and there is one Java test.
- `NavBar.js` is not imported anywhere, so it needs no change.
- `Results.js` has `mixed` and `prediction` views that no route reaches. `experiments/tools/prediction_report.py`, which its message mentions, does not exist. These views are excluded from the section list because they are not on the public site.

---

## 3. Module map

| Module | Tag | Slug | Entry point | Component | Own server APIs |
|---|---|---|---|---|---|
| Overview | CORE | `overview` | `/` | `app/page.js` | Lab health, runs, jobs; Spring health, experiments |
| Signal Map | OSM | `signal-map` | `/ghaziabad` | `OsmSignalMap.js` | `osm-areas`, `/osm/*.json` snapshots |
| Live Lab | LIVE | `live-lab` | `/live` | `LiveLab.js`, `Heatmap.js` | options, jobs, osm-areas, stop-all |
| Before / After | DUAL | `before-after` | `/demo` | `BeforeAfter.js` | options, jobs, replay, result |
| Controllers | EVAL | `controllers` | `/controllers` | `Results.js` | runs, reports |
| Prediction | AI | `prediction` | `/prediction` | `PredictionDashboard.js` | None |
| Mixed Traffic | MIX | `mixed-traffic` | `/mixed` | `MixedTrafficSimulator.js` | None |
| How It Works | VIVA | `how-it-works` | Modal, no route | `SwarmExplainerModal.js` | None |

---

## 4. Sections found in each module (64 in total)

Each row is a real block of UI, with its source line. Slugs are proposals.

Sections are kept flat, with no section inside another, because you require that turning one off never affects another. A shared wrapper panel disappears on its own when all its sections are off.

### Overview: 9 sections (`frontend/app/page.js`)
| Section | Slug | Line |
|---|---|---|
| System telemetry cards | `telemetry-status` | 265 |
| KPI improvement highlights | `kpi-highlights` | 297 |
| Simulation Command Center (scenario picker, Run Live Simulation) | `command-center` | 354 |
| Feature navigation cards | `feature-cards` | 388 |
| Grid Architectures & What They Mean | `grid-architectures` | 441 |
| Measured Benchmark comparison | `measured-benchmark` | 526 |
| Benchmark fuel and emissions card | `benchmark-fuel` | 550 |
| Raw Telemetry JSON | `benchmark-raw-json` | 559 |
| Measured Simulation Artifacts | `run-artifacts` | 571 |

### Signal Map: 15 sections (`frontend/components/OsmSignalMap.js`)
| Section | Slug | Line |
|---|---|---|
| Quick Place, Scan Area and Map Style selectors | `place-controls` | 982 |
| Place search and Scan This View | `place-search` | 1022 |
| Loaded OSM statistics strip | `area-stats` | 1045 |
| Download .osm and GeoJSON | `osm-exports` | 1073 |
| Simulate in SUMO Lab | `send-to-lab` | 1079 |
| Swarm / Fixed Timer mode toggle | `mode-toggle` | 1107 |
| Emergency Ambulance Corridor trigger | `emergency-corridor` | 1116 |
| Play, pause and speed controls | `sim-controls` | 1124 |
| Packets, vehicles and road-link layers | `map-layers` | 1134 |
| Map legend | `map-legend` | 1140 |
| Interactive signal map | `map-canvas` | 1170 |
| Inter-agent terminal | `swarm-terminal` | 1218 |
| Selected junction status | `junction-status` | 1220 |
| Real-time fuel and CO₂ impact panel | `impact-panel` | 1247 |
| Signal inventory table | `signal-inventory` | 1251 |

Not toggleable: the OpenStreetMap attribution footnote (line 1282). The ODbL licence requires it, so it stays while the module is on. The "How Swarm Intelligence Works" button at line 968 belongs to the How It Works module.

### Live Lab: 11 sections (`frontend/components/LiveLab.js`, `Heatmap.js`)
| Section | Slug | Line |
|---|---|---|
| Experiment job form | `experiment-form` | LiveLab 180 |
| Real-world areas | `real-world-areas` | LiveLab 181 |
| Stop all running | `stop-all` | LiveLab 178 |
| 2D Heatmap view | `view-heatmap` | Heatmap 18 |
| 3D City Grid view | `view-city-3d` | Heatmap 19 |
| World Map view | `view-world` | Heatmap 20 |
| 3D Intersection (digital twin) view | `view-digital-twin` | Heatmap 21 |
| Emergency vehicles | `emergency-panel` | LiveLab 189 |
| Fuel and emissions | `fuel-card` | LiveLab 191 |
| Swarm green-wave calls | `swarm-calls` | LiveLab 204 |
| Jobs table | `jobs-table` | LiveLab 206 |

### Before / After: 7 sections (`frontend/components/BeforeAfter.js`)
| Section | Slug | Line |
|---|---|---|
| Demo job form | `demo-form` | 40 |
| Demo jobs list | `demo-jobs` | 43 |
| Live side-by-side comparison | `live-comparison` | 48–54 |
| Historical replay | `replay` | 46–49 |
| Per-side emergency panels | `emergency-panels` | 54 |
| Fuel and emissions | `fuel-card` | 58 |
| KPI comparison table | `kpi-table` | 68 |

### Controllers: 5 sections (`frontend/components/Results.js`)
| Section | Slug | Line |
|---|---|---|
| Evaluation confidence-interval chart | `evaluation-ci-chart` | 64 |
| Evaluation paired statistical tests | `evaluation-paired-tests` | 65 |
| Saved-run KPI charts | `saved-run-charts` | 28 |
| Saved-run KPI table | `saved-run-kpi-table` | 33 |
| Controller configurations | `saved-run-config` | 34 |

### Prediction: 5 sections (`frontend/components/PredictionDashboard.js`)
| Section | Slug | Line |
|---|---|---|
| Place, horizon and feed controls | `forecast-controls` | 146 |
| Junction selector | `junction-selector` | 191 |
| Forecast KPI cards | `kpi-cards` | 221 |
| Predictive queue graph | `queue-graph` | 260 |
| Pre-emptive swarm action | `preemptive-action` | 325 |

### Mixed Traffic: 5 sections (`frontend/components/MixedTrafficSimulator.js`)
| Section | Slug | Line |
|---|---|---|
| City selector | `city-selector` | 138 |
| Composition controls | `composition-controls` | 158 |
| Fleet breakdown chart | `fleet-breakdown` | 204 |
| Fuel, delay and CO₂ highlights | `impact-highlights` | 232 |
| Fixed vs Swarm comparison graph | `comparison-graph` | 259 |

### How It Works: 7 sections (`frontend/components/SwarmExplainerModal.js`)
| Section | Slug | Line |
|---|---|---|
| Fixed timer vs swarm cards | `compare-cards` | 216 |
| Lookahead platooning | `lookahead` | 245 |
| Decentralised architecture flow | `architecture-flow` | 274 |
| ACO pheromone weighting and rules | `aco-weighting` | 303 |
| Fuel, CO₂ and savings | `fuel-savings` | 317 |
| Ambulance green wave | `ambulance-wave` | 326 |
| Evaluator Q&A | `evaluator-qa` | 338 |

### Cross-module links the toggles must respect
These change what is available at the moment of use and never change a saved state.

| Link | Source | Rule |
|---|---|---|
| Feature cards point to Signal Map, Live, Before/After and Controllers | `app/page.js:396–436` | Hide each card when its target module is off |
| Run Live Simulation redirects to `/live` | `app/page.js:235` | Without Live Lab, keep the visitor on the page and show a message |
| Simulate in SUMO Lab redirects to `/live` | `OsmSignalMap.js:882` | Available only when Live Lab and `real-world-areas` are both on |
| How It Works has two entry points | `Sidebar.js:183`, `OsmSignalMap.js:968` | Both follow the module toggle |
| `Heatmap` is shared by Live Lab and Before/After | `BeforeAfter.js:51` | The view toggles apply only to Live Lab, through a new optional prop that defaults to all views |
| Heatmap opens the World view for OSM networks | `Heatmap.js:56` | Fall back to the first view that is on |
| Heatmap quick-launch buttons | `Heatmap.js:774–790` | Hide when the target view is off |

---

## 5. Database changes

**Adapting the suggested structure:** the audit found no equivalent configuration table in the repository. Phase 4 starts with a read-only check of the live database, in case one was created outside the repository.

```sql
create table if not exists site_modules (
  id smallint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  identifier text not null unique,
  is_enabled boolean not null default true,
  sort_order smallint not null,
  updated_at timestamptz not null default now()
);

create table if not exists site_module_sections (
  id smallint generated always as identity primary key,
  module_id smallint not null references site_modules(id) on delete restrict,
  name text not null,
  slug text not null,
  is_enabled boolean not null default true,
  sort_order smallint not null,
  updated_at timestamptz not null default now(),
  unique (module_id, slug)
);

create table if not exists admin_sessions (
  token_hash text primary key,          -- SHA-256 of the cookie token; the token itself is never stored
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists admin_login_attempts (
  key_hash text primary key,            -- hash of username + client IP
  failed_count integer not null default 0,
  window_started_at timestamptz not null default now()
);
```

The migration also:
- adds a trigger that keeps `updated_at` current;
- **enables row-level security with no policies** on all four tables, and revokes access from `anon` and `authenticated`. Supabase exposes tables in `public` through its REST API, and a `NEXT_PUBLIC_` anon key is in the environment, so skipping this would let anyone flip toggles;
- seeds 8 modules and 64 sections with `ON CONFLICT DO NOTHING`.

**Persistence:** because the seed never updates an existing row, re-running it cannot create duplicates or reset a toggle. Future sections are added by the same method.

**Delivery:** one idempotent file, `db/migrations/001_admin_panel.sql`, applied once. It stays out of `schema.sql` so that admin tables do not depend on a Render backend restart or on `continue-on-error`, which would hide a failed migration. Applying it to production is a separate step that I will confirm with you first.

---

## 6. Admin authentication

**Decision: custom server-side login in Next.js, with sessions stored in Postgres.**

Spring Security was rejected because the Render backend does not sit in front of the pages or the Lab API. Supabase Auth was rejected because this app does not otherwise use it, and it would add user management for a single admin.

| Concern | Design |
|---|---|
| Credentials | `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`, server-only environment variables. Nothing is hardcoded or prefixed `NEXT_PUBLIC_`. |
| Hashing | scrypt from Node's built-in `node:crypto`, compared with `timingSafeEqual`. A small script generates the hash. The hash format avoids `$`, which Next's env loader would try to expand. |
| Session | 32 random bytes in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, for 8 hours. Only its SHA-256 is stored, so logging out revokes it on the server. |
| Brute force | Stored in Postgres because serverless instances share no memory: 5 failures per username and IP locks that key for 15 minutes. Errors are generic. |
| CSRF | `SameSite=Strict`, plus an `Origin` check on every admin write. |
| Access control | `proxy.js` makes a first check, and **every admin route handler and the dashboard re-validate the session against the database**. If the database is unreachable, admin access fails closed. |
| Output | `Cache-Control: no-store` and `noindex` on admin responses. |

Before Phase 3, I will read `authentication-with-cache-components.md` from the installed Next.js docs, as `frontend/AGENTS.md` requires.

---

## 7. API endpoints

**New: public**
| Method and path | Purpose |
|---|---|
| `GET /api/site-config` | Effective flags only (parent rules already applied), `no-store`. Exposes no admin data. |

**New: admin, session required**
| Method and path | Purpose |
|---|---|
| `POST /api/admin/login` | Verify credentials and create a session |
| `POST /api/admin/logout` | Delete the session and clear the cookie |
| `GET /api/admin/modules` | Modules and sections with saved states and `updated_at` |
| `PATCH /api/admin/modules/{slug}` | Body `{ "is_enabled": boolean }` |
| `PATCH /api/admin/modules/{slug}/sections/{sectionSlug}` | Body `{ "is_enabled": boolean }` |

Modules and sections cannot be created, renamed or deleted through the API, so the eight required modules cannot be altered from the panel.

**Effective state:** `section available = module.is_enabled AND section.is_enabled`. A module toggle changes one row only, so sections return to their saved states when the module comes back.

### Enforcement on existing APIs
A shared route handler guard runs in `/api/lab` and `/api/proxy` and returns `403 {"error":"module_disabled"}`. An endpoint is **allowed if any section that uses it is available**, which keeps shared endpoints working for the other modules.

| Endpoint (`/api/lab/...`) | Allowed when any of these is available |
|---|---|
| `health` | Always |
| `options` | live-lab `experiment-form`; before-after `demo-form` |
| `osm-areas` GET | live-lab `real-world-areas`, `experiment-form`; before-after `demo-form` |
| `osm-areas` POST | live-lab `real-world-areas`; signal-map `send-to-lab` |
| `jobs` POST, `kind=experiment` | live-lab `experiment-form` |
| `jobs` POST, `kind=demo` | before-after `demo-form`; overview `command-center` |
| `jobs` GET, `jobs/{id}` | Live Lab or Before / After module on |
| `jobs/{id}/stop` | live-lab `jobs-table`; before-after `demo-jobs` |
| `stop-all` | live-lab `stop-all` |
| `jobs/{id}/live` | Any Live Lab view; before-after `live-comparison`, `replay` |
| `jobs/{id}/replay` | before-after `replay` |
| `jobs/{id}/result` | live-lab `fuel-card`; before-after `fuel-card`, `kpi-table` |
| `jobs/{id}/calls` | live-lab `swarm-calls` |
| `jobs/{id}/messages` | Live Lab module on (no UI uses it today) |
| `runs` | overview benchmark sections, `kpi-highlights`, `run-artifacts`; any controllers `saved-run-*` |
| `runs/comparison` | Same as `runs` |
| `runs/replay`, `runs/calls` | Controllers module on (no UI uses them today) |
| `reports`, `reports/{name}` | controllers `evaluation-*` |
| `swarm/mesh/*` | Signal Map module on (no UI uses it today; the browser runs the same engine locally) |

| Endpoint (`/api/proxy/...`) | Allowed when |
|---|---|
| `api/health` | Always |
| `api/experiments`, `api/experiments/{id}`, `.../run` | Overview module on |
| Anything else, such as `actuator/*` | **Blocked.** The catch-all forwards these today, but no UI uses them. This is a deliberate behaviour change. |

Unmapped paths are denied by default. Existing tests call FastAPI directly, so they are unaffected.

---

## 8. Frontend integration

### 8.1 Plan
1. **Route structure.** Move public pages into `app/(public)/` with a new layout holding `.app-shell` and `Sidebar`. URLs do not change. `app/admin/` gets its own layout, so the public sidebar does not render there.
2. **`frontend/proxy.js`.** Matches module pages and `/osm/*`, and blocks disabled modules on the server. A disabled route shows a "module unavailable" page.
   - `/` with Overview off redirects to the first enabled module.
   - With everything off, it shows the unavailable page.
3. **`lib/siteConfig.js`.** Server-side read of the configuration, cached per instance for 5 seconds, so server enforcement takes effect in about 5 seconds.
4. **`SiteConfigProvider` and `useSection(module, slug)`.** A client provider in the public layout fetches `/api/site-config` at load, every 15 seconds, and on window focus.
5. **Client gate.** Required because Cache Components keeps visited routes in hidden state, so a previously opened page could reappear without a server request.
6. **Sidebar.** Filters `NAV_ITEMS` and the How It Works button from the config.
7. **Module components.** Wrap each section in a small condition, leaving calculations, hooks and API code as they are.
   - `map-canvas` needs care because Leaflet initialises against its container. It will stay mounted and be hidden, rather than unmounted.
8. **Polling.** Lab polling hooks stop while their section is off, and a 403 is handled quietly so disabled sections do not produce error banners.
9. **Admin dashboard.** A dark command-centre layout built from `globals.css` tokens, with no redesign of the public site.
   - **Module cards:** expandable, with an ON/OFF switch, status badge and last-updated time.
   - **Section rows:** each has its own switch, and shows "Saved ON, unavailable while module is off" where that applies.
   - **Toggle behaviour:** the switch updates at once, rolls back on error, and shows loading, success and error states.
   - **Confirmation:** only for turning a module off, or a section that a running job could depend on.
   - **Layout:** responsive for desktop and mobile.

### 8.2 Limits you should expect
- **Hiding is not secrecy.** Client component code stays in public JavaScript files, including How It Works text and Prediction and Mixed Traffic values. A disabled module cannot be opened through the site, but someone could still read the code in those files. The content is not sensitive, so I am not restructuring modules to avoid this.
- **No server block exists for browser-only behaviour.** Signal Map calls Overpass and Nominatim directly. Prediction and Mixed Traffic run wholly in the browser. For these, a toggle controls the page and the UI.
- **Open tabs update within 15 seconds or on focus.** The server enforces sooner, within about 5 seconds per instance.
- **Running jobs keep running.** Turning off a module blocks new jobs and access to it, but does not kill a SUMO run. Use Stop All first if needed.
- **If Supabase is unreachable,** the public site uses the last known configuration, or treats modules as on if an instance has none. I chose this so an outage does not take the whole site down. The cost is that a disabled module could briefly reappear on a fresh instance during an outage. Admin access always fails closed.

---

## 9. Security considerations

### 9.1 CRITICAL: database password is public
`backend/src/main/resources/application.properties:5` contains a default Supabase database password and line 4 a username, in the code since commit `ab54527`. The GitHub repository **responded publicly without login** (HTTP 200 on 2026-10-31).

The admin tables will live in this same database, so **anyone holding that password could turn modules on or off and forge sessions, bypassing the panel**. I did not test whether the password still works.

**Required before Phase 3:**
1. You rotate the database password in Supabase.
2. You set `DB_URL`, `DB_USER` and `DB_PASSWORD` on Render. The backend may currently depend on the committed default, and removing it before this would break the backend.
3. I remove the defaults from the file in Phase 3.

Editing the file does not remove the password from Git history, so rotation is the actual fix.

### 9.2 Direct access can bypass the gate
The gate protects traffic that goes through Next.js. The Render backend URL is public, its CORS default is `*`, and neither it nor the Lab API has authentication. Anyone calling them directly skips all module rules.

**Recommendation:** add a `TSI_GATEWAY_SECRET` header check.
- The Next proxies add the header, and a small FastAPI middleware and Spring filter require it.
- Each check is off when the variable is unset, so local development and tests behave as they do today.
- The health endpoints stay open.

This is a small change to the Python and Java services, so it is decision 2 in section 13.

### 9.3 Existing issues found, not in scope unless you ask
- **Unauthenticated operations:** any visitor can start jobs and call `stop-all` while Live Lab is on. Module toggles do not add per-user limits.
- **Prediction figures are not measured.** The dashboard uses sine-wave data and fixed values such as "94.2% (MAE 1.8 veh)" and "-68% queue reduction", labelled "Real-Time Online Model". Mixed Traffic also derives its results from fixed formulas. `README.md` states that the project ships no fabricated KPI improvements, so this is a real risk at a viva. The real prediction code in `simulation/prediction/` is not connected to this page.
- **Overview status is partly hard-coded.** "PORT 8001 UP" and the sidebar's "PSO + ACO OK" are fixed text.
- **Unused polling.** Overview fetches the Render backend every 6 seconds, but `backendHealth` and `experiments` are never displayed (`app/page.js:120–121`).
- **Out-of-date docs.** `README.md` and `backend/.env.example` still describe MySQL. Phase 7 will correct only the parts this work touches.

### 9.4 New code
- The service role key is used only in server code.
- All toggle input is validated as strict booleans against known slugs.
- No secrets go to the browser or logs.
- A test checks the built client files for the secret names and values.

---

## 10. Files to change

**New**
```
db/migrations/001_admin_panel.sql
frontend/proxy.js
frontend/lib/siteConfig.js                  server config read and cache
frontend/lib/adminAuth.js                   hashing, sessions, throttling, origin check
frontend/lib/labGuard.js                    endpoint rules from section 7
frontend/lib/moduleRegistry.js              routes and dependency rules
frontend/components/SiteConfigProvider.js
frontend/components/ModuleUnavailable.js
frontend/components/admin/*                 login form, dashboard, module card, switch
frontend/app/(public)/layout.js
frontend/app/admin/layout.js
frontend/app/admin/page.js                  login or dashboard, by session
frontend/app/api/site-config/route.js
frontend/app/api/admin/login/route.js
frontend/app/api/admin/logout/route.js
frontend/app/api/admin/modules/route.js
frontend/app/api/admin/modules/[slug]/route.js
frontend/app/api/admin/modules/[slug]/sections/[sectionSlug]/route.js
frontend/scripts/hash-admin-password.mjs
Tests: see section 11
```

**Moved, content unchanged except as listed below**
```
frontend/app/page.js              → frontend/app/(public)/page.js
frontend/app/{ghaziabad,live,demo,controllers,prediction,mixed}/page.js → frontend/app/(public)/.../page.js
```

**Modified**
| File | Change |
|---|---|
| `frontend/app/layout.js` | Keep `<html>`, `<body>` and fonts; move shell to the public layout |
| `frontend/app/(public)/page.js` | Section conditions, card rules, redirect guard |
| `frontend/app/globals.css` | Add admin styles only |
| `frontend/app/api/lab/[...path]/route.js` | Call the guard; POST body read once and reused |
| `frontend/app/api/proxy/[...path]/route.js` | Call the guard; add allowlist |
| `frontend/components/Sidebar.js` | Filter items from config |
| `frontend/components/OsmSignalMap.js` | Section conditions, Live Lab dependency |
| `frontend/components/LiveLab.js` | Section conditions, pause polling when off |
| `frontend/components/BeforeAfter.js` | Section conditions, replay fallback |
| `frontend/components/Heatmap.js` | Optional `allowedViews` prop, default all |
| `frontend/components/Results.js` | Section conditions |
| `frontend/components/PredictionDashboard.js` | Section conditions |
| `frontend/components/MixedTrafficSimulator.js` | Section conditions |
| `frontend/components/SwarmExplainerModal.js` | Section conditions |
| `backend/src/main/resources/application.properties` | Remove default database credentials, after rotation |
| `.env.example` | Add admin variables |

**If decision 2 is approved:** `experiments/lab/api.py`, plus a new servlet filter under `backend/src/main/java/com/traffic/swarm/controller/`.

**Not touched:** `simulation/`, `optimizer/`, `experiments/tools/`, `ExperimentService`, `ExperimentOrchestrator`, `lib/swarmMesh.js`, `lib/osmSignals.js`, and all calculations.

---

## 11. Testing strategy

**Tooling:** Node's built-in test runner covers logic with no new dependency. Browser checks use a real run of the app with the Chrome tools. Playwright will not be added unless you want it kept as a permanent suite.

| Your requirement | How it is tested |
|---|---|
| 1. `/admin` shows login when unauthenticated | Browser, plus HTTP check |
| 2. Invalid credentials rejected | Test, including lockout after 5 failures |
| 3. Login opens dashboard | Browser |
| 4. All 8 modules, exactly once | Test against the database, plus browser |
| 5. Sections under the correct modules | Test comparing database rows with the registry |
| 6–7. Independent toggles | Test that a PATCH changes exactly one row |
| 8. Parent off makes sections unavailable | Test on effective-state logic and `/api/site-config` |
| 9. Saved states preserved through parent off and on | Test comparing full state before and after |
| 10. Sidebar updates | Browser |
| 11. Direct route access blocked | HTTP check on all 7 routes, plus How It Works entry points in browser |
| 12. APIs enforce rules | Table-driven test of every row in section 7, including shared endpoints |
| 13. Refresh and restart preserve settings | Browser, and re-run the seed then compare |
| 14. Logout ends access | Replay the old cookie and expect 401 |
| 15. Simulation still works | `pytest`, including SUMO-marked tests; `mvn test`; `next build`; one real Live Lab job and one Before/After job, end to end |
| 16. Nothing removed | Compare route and API lists before and after, and confirm the diff of `simulation/` and `optimizer/` is empty |

**Baseline:** before changing anything in Phase 3, I will record current `pytest`, `mvn test` and `next build` results, so older failures are not confused with regressions.

**Database for testing:** a separate Supabase project or a local Postgres, so tests never write to production toggles.

---

## 12. Deployment strategy

Order matters, because the proxies and pages need the tables to exist first.

1. Rotate the database password and update Render (section 9.1).
2. Generate the admin password hash locally.
3. Set Vercel variables, for Production and Preview separately:
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (check these exist)
   - `TSI_GATEWAY_SECRET` (if approved)
   - `LAB_URL` (see decision 3)
4. Apply `001_admin_panel.sql` to Supabase. All toggles start ON, so nothing changes for visitors.
5. Deploy services: backend first, then the Lab API if changed, then the frontend.
6. Smoke test `/admin`, toggle one low-risk section off and on, and confirm the public site follows.

**Rollback:** redeploy the previous Vercel build. The new tables are additive and do not affect it, and with every toggle ON the site behaves as it does today.

---

## 13. Decisions needed for approval

1. **Approve the 64-section list in section 4**, or tell me which to merge or drop. Fine-grained items such as `benchmark-raw-json` and `map-legend` could be merged if you want a simpler panel.
2. **Gateway secret (section 9.2).** Recommended, otherwise the module rules can be bypassed by calling Render or the Lab API directly. It requires small changes to `experiments/lab/api.py` and a new Spring filter, which you asked me to treat carefully.
3. **Where does the Lab API run in production?** `LAB_URL` is not in the repository's `.env`, and it defaults to `localhost:8090`. If it is unset on Vercel, Overview, Live Lab, Before/After and Controllers cannot reach the lab in production today. Live API testing must then run locally. Please check Vercel and tell me.
4. **Rotate the database password** (section 9.1). This is yours to do and must happen before Phase 3.
5. **Prediction and Mixed Traffic figures (section 9.3).** The admin work leaves them as they are. You may want them relabelled as illustrative before your viva, as separate work.

## 14. Phases after approval

| Phase | Work | Stops for you? |
|---|---|---|
| 3 | Baseline tests, route groups, login, sessions, logout | Password rotation needed first |
| 4 | Migration, admin APIs, dashboard, toggles | Confirm before applying to production |
| 5 | Proxy gate, API guard, sidebar, section conditions | No |
| 6 | Full test matrix and regression fixes | Report results |
| 7 | Migration and deployment instructions, final report | No production deploy without your go-ahead |
