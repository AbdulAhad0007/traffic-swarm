# Site Themes and Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin choose one of three site-wide themes from the bottom of the admin panel, and redesign every public module on one themeable design system.

**Architecture:** One saved theme slug travels through `getSiteConfig`. `proxy.js` copies it to a `tsi-theme` cookie, and a blocking inline script applies it as `data-theme` on `<html>` before first paint. `SiteConfigProvider` keeps open tabs in step. All colors, type and component style come from CSS variables defined per `[data-theme]`; canvas and Leaflet code read resolved values through a small client helper.

**Tech Stack:** Next.js 16.4 (`cacheComponents` on), React 19, plain CSS, lucide-react, recharts, Leaflet, Supabase REST, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-01-site-themes-and-redesign-design.md`

## Global Constraints

- Theme slugs are exactly `midnight` (default), `night-road`, `survey-map`. Theme values come from the spec's table.
- Midnight keeps today's palette and fonts exactly.
- No module, section, control, data value or module toggle may be lost. Section slugs from `db/migrations/001_admin_panel.sql` stay wired through `useSections`.
- The green wave and traffic-signal colors keep their meaning in all themes.
- No new UI framework or dependency. No backend, optimizer or simulation changes.
- Read the relevant guide in `frontend/node_modules/next/dist/docs/` before changing layout, proxy or route code.
- Responsive to phone width, visible keyboard focus, `prefers-reduced-motion` respected, readable contrast in all three themes.
- Work on branch `feat/site-themes`, not `main`. Run all commands from `frontend/`. E2E tests need `npm run build` first.

## Review Focus

- Migration not applied yet: the site and module toggles keep working, and the theme is Midnight. Tested in Task 1.
- Database goes down after a non-default theme was saved: the site keeps that theme until restart, then Midnight. Tested in Task 1.
- Tampered or stale `tsi-theme` cookie: an unknown value falls back to Midnight and is never written into the page. Tested in Task 2.
- A visitor is redirected because a module is off, or lands on `/unavailable`: the theme still applies with no flash. Tested in Task 2.
- A map or canvas is animating when the theme changes: it redraws in the new colors without reload and without resetting the user's view. Tested in Task 2 for the event, and checked in Task 7.

---

### Task 1: Theme registry, storage and admin API

**Files:**
- Create: `lib/themes.js`, `../db/migrations/002_site_theme.sql`, `app/api/admin/theme/route.js`
- Modify: `lib/siteConfig.js`, `lib/moduleRegistry.js:133`, `tests/helpers/fakeServices.mjs`, `tests/unit.test.mjs`, `tests/admin.e2e.test.mjs`, `../.gitignore`, `../docs/ADMIN_PANEL_DEPLOYMENT.md`

**Interfaces:**
- Produces: `THEMES: {slug, name, description}[]`, `DEFAULT_THEME = 'midnight'`, `isThemeSlug(value): boolean`, `normalizeTheme(value): string`, all from `lib/themes.js` with no `server-only` import.
- Produces: `/api/site-config` returns `{ modules, theme }`. `ALL_ENABLED` includes `theme: DEFAULT_THEME`.
- Produces: `GET /api/admin/theme` returns `{ theme }` or 503. `PATCH /api/admin/theme` takes `{ theme }` and returns `{ theme, updated_at }`.

- [ ] **Step 1: Create the branch and ignore mockups**

Run `git switch -c feat/site-themes`. Add `.superpowers/` to `../.gitignore`.

- [ ] **Step 2: Write failing tests**

In `unit.test.mjs`: `normalizeTheme('night-road') === 'night-road'`; `normalizeTheme('x')`, `normalizeTheme(null)` and `normalizeTheme('__proto__')` all return `'midnight'`.

In `admin.e2e.test.mjs`, add `site_settings: [{ id: 1, theme: 'midnight', updated_at }]` to `seedTables()`, reset it in `beforeEach`, and add:
- `theme PATCH without a session returns 401`
- `theme PATCH with an unknown slug returns 400 invalid_theme and changes nothing`
- `theme PATCH saves and /api/site-config returns it immediately`
- `missing site_settings table: site-config returns theme midnight and module toggles still work` (delete the table from fake state, toggle a module, assert its effect)
- `database down after saving night-road: site-config still returns night-road`
- `saved row with an invalid theme returns midnight`

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run build; npm test`
Expected: the new tests FAIL, existing tests PASS.

- [ ] **Step 4: Write the migration**

Re-runnable, same style as `001`: table `public.site_settings (id smallint primary key default 1 check (id = 1), theme text not null default 'midnight' check (theme in ('midnight','night-road','survey-map')), updated_at timestamptz not null default now())`, the touch trigger, RLS enabled, revokes from `anon, authenticated`, and `insert ... (id) values (1) on conflict do nothing`.

- [ ] **Step 5: Implement `lib/themes.js`, the config change and the route**

In `load()`, fetch `site_settings?select=theme&id=eq.1` in its own try/catch so a failure cannot affect module flags. On failure use `state.config?.theme ?? DEFAULT_THEME`. Always pass the value through `normalizeTheme`. The route follows `app/api/admin/modules/[slug]/route.js`: `denyUnlessAdmin(request, { write: true })` for PATCH, `denyUnlessAdmin(request)` for GET, `invalidateSiteConfig()` after save, and 503 `service_unavailable` when no row is returned or the database errors.

- [ ] **Step 6: Document the migration**

Add a step to `docs/ADMIN_PANEL_DEPLOYMENT.md`: run `002_site_theme.sql`; until then the site stays on Midnight and the Theme section shows an error.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build; npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

`git commit -m "feat: add site theme setting, migration and admin API"`

### Task 2: Apply the theme without a flash

**Files:**
- Create: `lib/themeBoot.js`, `lib/themeClient.js`, `app/styles/tokens.css`
- Modify: `proxy.js`, `app/layout.js`, `components/SiteConfigProvider.js`, `app/globals.css:6-65`, `tests/unit.test.mjs`, `tests/admin.e2e.test.mjs`

**Interfaces:**
- Consumes: `normalizeTheme`, `THEMES`, `config.theme` from Task 1.
- Produces: `themeBootScript: string` from `lib/themeBoot.js`.
- Produces from `lib/themeClient.js`: `applyTheme(slug): void` (sets `data-theme` on `<html>`, loads that theme's fonts, dispatches `tsi-theme-change` on `window`, and does nothing if unchanged); `readToken(name): string`; `useThemeTokens(names: string[]): Record<string,string>` (re-resolves on `tsi-theme-change`).
- Produces in `tokens.css`, for `:root, [data-theme="midnight"]`, `[data-theme="night-road"]`, `[data-theme="survey-map"]`:
  - Surfaces: `--bg-base --bg-image --bg-surface --bg-elevated --bg-sunken --line --line-strong`
  - Text: `--text-primary --text-secondary --text-muted`
  - Accents: `--accent --accent-ink --accent-2`, where `--accent-ink` is text on an accent fill
  - Status: `--status-ok --status-warn --status-danger`
  - Signals: `--signal-green --signal-amber --signal-red --wave`, where `--wave` is `var(--signal-green)` in all themes
  - Style: `--radius-sm --radius --radius-lg --shadow-1 --shadow-2 --font-display --font-main --font-mono --map-base`, where `--map-base` is `dark` or `light`
- Survey Map's `--status-danger` is `#b91c1c`, clearly apart from its `#d9480f` accent.

- [ ] **Step 1: Write failing tests**

Unit, running `themeBootScript` with `new Function` against fake `document` and `location` objects:
- `boot script applies a valid cookie theme`
- `boot script ignores tsi-theme=<script>alert(1)</script> and leaves midnight`
- `boot script skips /admin paths`

Unit: `useThemeTokens` source subscribes to `tsi-theme-change`; `applyTheme` dispatches the event once and not on a repeat call (fake `window` and `document`).

E2E, after saving `night-road`:
- `proxy sets tsi-theme=night-road on /`
- `proxy sets the cookie on the redirect when overview is off`
- `/unavailable sets the cookie`
- `root HTML contains the boot script`
- `proxy does not set a cookie when the request already carries the correct value`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build; npm test`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement cookie, script, provider and tokens**

Read the proxy and layout guides under `node_modules/next/dist/docs/01-app` first.

`proxy.js`: wrap each return in a helper that sets the cookie when it differs from the request's value (`path=/`, `sameSite=lax`, one year, not HttpOnly, because the script reads it). Add `/unavailable` to `matcher`.

`app/layout.js`: add `suppressHydrationWarning` to `<html>`, and render the inline script as the first child of `<head>`. It validates against the slug allowlist, sets `data-theme`, and appends the font link for non-default themes. Remove the duplicate `@import` from `globals.css`.

`SiteConfigProvider`: call `applyTheme(c.theme)` after each load.

Move the `:root` tokens from `globals.css` into `tokens.css` and keep today's variable names as aliases to the new tokens, so nothing visually changes under Midnight yet.

- [ ] **Step 4: Run tests and check by hand**

Run: `npm run build; npm test`
Expected: all PASS. With `npm run dev`, set the theme through the API. Hard reload shows no flash of Midnight. Midnight looks unchanged.

- [ ] **Step 5: Commit**

`git commit -m "feat: apply saved theme site-wide before first paint"`

### Task 3: Admin Theme section

**Files:**
- Create: `components/admin/ThemePicker.js`
- Modify: `components/admin/AdminDashboard.js`, `app/admin/layout.js`, `app/globals.css`, `tests/unit.test.mjs`

**Interfaces:**
- Consumes: `THEMES`, `GET` and `PATCH /api/admin/theme`.
- Produces: `<ThemePicker notify={fn} onExpired={fn} />`.

- [ ] **Step 1: Write the failing test**

Static source test `admin dashboard renders ThemePicker after the module list`: the index of `<ThemePicker` in `AdminDashboard.js` is after `admin-modules`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Pin the admin to its own look by wrapping `app/admin/layout.js` children in `<div data-theme="midnight">`, with `.admin-shell` setting its own background. Each card is a `<button aria-pressed>` with its own `data-theme={slug}`, so it previews the real tokens: background, surface, accent, and a headline in the theme's display font. Load all three themes' fonts on the admin page only.

Save immediately with an optimistic update. On failure, revert and show `Could not save the theme. The previous theme was kept.` On success show `Theme changed to {name}.` If GET returns 503, show `Could not load the theme. Check that the 002_site_theme migration has been applied.`

- [ ] **Step 4: Verify**

Run: `npm run build; npm test`
Expected: all PASS. By hand: picking a theme updates another open public tab within 15 seconds or on focus, and the admin panel's own look does not change.

- [ ] **Step 5: Commit**

`git commit -m "feat: add theme picker to the admin panel"`

### Task 4: Design system and tokenised stylesheet

**Files:**
- Create: `app/styles/system.css`, `tests/theme.guard.test.mjs`
- Modify: `app/globals.css`, `app/layout.js`, `package.json`

**Interfaces:**
- Produces: restyled shared classes that later tasks reuse with their existing names: `.panel .badge .status .error .muted`, `.tabs`, buttons, inputs, tables, `.explainer-backdrop`.
- Produces: `tests/theme.guard.test.mjs` with an exported-in-file `THEMED_FILES` list. Later tasks append to it. Each listed file must contain no `#rgb`, `#rrggbb`, `rgb(` or `rgba(` literal. Each entry may name an allowlist of data-only literals with a comment saying why.

- [ ] **Step 1: Write the guard tests**

`globals.css` and `system.css` have no color literals. Add a second test, `every section slug is still referenced`: each section slug in `MODULES` appears as a quoted string in `components/` or `app/(public)/`.

- [ ] **Step 2: Run to verify the color guard fails**

Add the guard file to the `test` script in `package.json`. Run: `npm test`
Expected: the color test FAILS on `globals.css`, and the slug test PASSES.

- [ ] **Step 3: Replace literals in `globals.css` with tokens**

Replace about 540 lines. Translucent colors become `color-mix(in srgb, var(--accent) N%, transparent)`. Signal and emergency styling uses `--signal-*`.

- [ ] **Step 4: Build `system.css` and retire the old look**

Set the type scale, spacing, panels, buttons, tables, form controls, tabs, badges, modals and focus rings. Remove `--neu-*` shadows, gradient text, gradient header bars and uppercase eyebrow pills. Corners and shadows come only from tokens. Night Road's warning badge carries an icon or label, not only color.

- [ ] **Step 5: Verify and review**

Run: `npm run build; npm test`
Expected: all PASS. Take screenshots of Overview under all three themes. The Midnight palette and fonts must match today's.

- [ ] **Step 6: Commit**

`git commit -m "feat: tokenise stylesheet and add shared design system"`

**Tasks 5 to 10 all follow this cycle.** Add the task's files to `THEMED_FILES`. Run `npm test` and confirm the guard FAILS. Replace literals with tokens and redesign the layout. Use `var(--token)` in SVG, Recharts and inline styles, replacing `${color}33` alpha strings with `color-mix`. Run `npm run build; npm test` and confirm all PASS, including the section-slug test. Screenshot each module in all three themes at desktop and 390px width. Turn each of the module's sections off once and confirm only that section goes. Commit.

### Task 5: App shell

**Files:** `components/Sidebar.js`, `components/NavBar.js`, `components/ModuleUnavailable.js`, `components/RichDropdown.js`, `app/(public)/layout.js`, related CSS.

Replace hardcoded icon colors with `currentColor` or tokens. Keep the collapse behavior, mobile drawer, module filtering and How It Works button. Commit: `feat: redesign app shell`.

### Task 6: Overview and junction mesh

**Files:**
- Create: `components/JunctionMesh.js`
- Modify: `app/(public)/page.js`, `components/FuelSavedCard.js`, related CSS

**Interfaces:**
- Produces: `<JunctionMesh />`, a self-contained 3×3 SVG with no props and no data source.

Test `JunctionMesh wave path is drawn with var(--wave)`, and that its source contains a `prefers-reduced-motion` rule, or the CSS does. Under reduced motion the wave is shown static.

The hero is the mesh plus "Traffic Swarm Intelligence Lab", the method line, simulation status, version and supported grid sizes. It is always shown, ignores section toggles and contains no KPIs or run button. A caption says the mesh is an illustration of the coordination. Grid accent colors in `GRID_ARCHITECTURES` become tokens. Commit: `feat: redesign Overview with junction mesh hero`.

### Task 7: Signal Map

**Files:** `components/OsmSignalMap.js`, `components/SwarmTerminal.js`, `components/SwarmImpactPanel.js`, related CSS.

The fx canvas reads colors from `useThemeTokens` through a ref inside its draw loop, so a theme change never restarts the simulation or resets the map view. Line 1181's inline `#090e18` becomes `var(--bg-sunken)`. The base map follows `--map-base` (light tiles on Survey Map) until the user picks a map style, and the user's pick wins for that session.

By hand: change the theme with the map running. Colors change within the refresh, and vehicles, zoom and selected junction are unchanged. Commit: `feat: redesign Signal Map`.

### Task 8: Live Lab

**Files:** `components/LiveLab.js`, `components/Heatmap.js`, `components/CityGrid3D.js`, `components/DigitalTwin3D.js`, `components/WorldHeatmap.js`, `components/SwarmCallsPanel.js`, related CSS.

`CityGrid3D` and `DigitalTwin3D` are SVG, so they take `var()` attributes directly. If any color is computed in JS (shading), use `useThemeTokens`. `WorldHeatmap` handles its base map as in Task 7. Commit: `feat: redesign Live Lab`.

### Task 9: Before / After, Controllers, Prediction, Mixed Traffic

**Files:** `components/BeforeAfter.js`, `components/Results.js`, `components/PredictionDashboard.js`, `components/MixedTrafficSimulator.js`, related CSS.

Chart series use tokens with direct labels or legends that work in all themes. Vehicle-class colors in Mixed Traffic may stay as allowlisted data colors only if they pass contrast on all three surfaces. Fixed vs Swarm keep consistent roles across modules. Commit: `feat: redesign comparison, prediction and mixed traffic modules`.

### Task 10: How It Works

**Files:** `components/SwarmExplainerModal.js`, related CSS. Commit: `feat: redesign How It Works`.

### Task 11: Final verification

**Files:** `tests/theme.guard.test.mjs`, leftover CSS.

- [ ] **Step 1: Close the guard**

Add every remaining `components/*.js` and `app/(public)/page.js` to `THEMED_FILES`. Delete CSS left unused by the redesign, including the old-name aliases from Task 2 once nothing uses them.

- [ ] **Step 2: Run everything**

Run: `npm run build; npm test`
Expected: all PASS.

- [ ] **Step 3: Check the full matrix in the browser**

Check every module × 3 themes × desktop and 390px: no horizontal scroll, readable contrast, keyboard focus visible, reduced motion respected. Fix what fails.

- [ ] **Step 4: Check the anti-goals**

Compare Midnight against `main` for palette and fonts. Compare each module's controls against `main` to confirm none were lost. Stop the database and confirm the site still renders with its last theme.

- [ ] **Step 5: Commit**

`git commit -m "chore: finish theme migration and remove old styles"`
