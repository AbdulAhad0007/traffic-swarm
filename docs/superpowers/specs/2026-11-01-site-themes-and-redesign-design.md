# Site themes and main website redesign

## Intent

The site owner wants to change how the whole public website looks from the admin panel, and wants the site itself to stop feeling old-fashioned. The site should look striking and modern on every module, while the default look stays recognisably the one in use today.

## Goals

- A Theme section at the bottom of the admin panel, below the module list, where the owner picks one of three themes.
- The selected theme applies to every visitor of the public site, not only the admin's browser.
- A redesign of every public module: shell and sidebar, Overview, Signal Map, Live Lab, Before / After, Controllers, Prediction, Mixed Traffic, How It Works.
- Midnight Command is the default whenever no valid saved theme can be read.

## Non-goals

- Per-visitor theme switching on the public site.
- Custom colors, a theme editor, or separate UI / color / background controls. (Builder's proposal, played back to the owner, who said to continue.)
- Backend, optimizer, simulation or API behavior changes beyond what the theme setting needs.
- Redesigning the admin panel beyond adding the Theme section and keeping it legible.

## Anti-goals

These would count as failure even if the switcher worked:

- The default site no longer feels like today's site.
- Any module, section, control, data value or module toggle is lost in the redesign.
- A chart, map, 3D view or modal stays stuck in Midnight colors, or becomes unreadable, under another theme.
- A non-default theme shows a visible flash of Midnight on page load.
- A database outage takes the site down or blanks its styling.

## The three themes

Each theme is a complete set of colors, background, typography and component style (corner radius, borders, shadows). The owner saw these as browser mockups.

| | Midnight Command (default) | Night Road | Survey Map |
|---|---|---|---|
| Slug | `midnight` | `night-road` | `survey-map` |
| Page background | `#090d16` with cyan and emerald radial glow | `#17181a` | `#eef3ee` |
| Surface | `#101828` | `#222326` | `#fbfcf8` |
| Text | `#f8fafc`, secondary `#94a3b8` | `#f6f1e3`, secondary `#aaa79d` | `#10302e`, secondary `#55706b` |
| Primary accent | `#38bdf8` | `#ffb000` | `#006f6b` |
| Secondary accent | `#10b981` | `#3ddc84` | `#d9480f` |
| Display / body type | Outfit / Plus Jakarta Sans | Saira Condensed / Barlow | Newsreader / Instrument Sans |
| Corners | 16px | 3px | 10px |
| Color scheme | dark | dark | light |

Midnight keeps today's palette and fonts exactly. Its components may change: cleaner, lighter shadows than the current heavy neumorphism.

Traffic-signal red, amber and green keep their meaning in every theme and are not re-themed to other hues. They may be adjusted for contrast. Status colors for success, warning and danger must also stay distinguishable in each theme.

## Admin panel

- Add a Theme section after the module list in `frontend/components/admin/AdminDashboard.js`.
- Show one preview card per theme with the theme's actual background, surface, accent and type, and mark the active one.
- Clicking a card saves immediately, following the module switches' pattern: optimistic, with a toast, and it reverts if the save fails. No confirm dialog.
- The admin panel keeps its own stable appearance whichever theme is active, so a bad theme choice can't make the controls hard to use. (Builder's call.)

## Saving and delivering the theme

- New migration `db/migrations/002_site_theme.sql`, re-runnable like `001`, holding one site-wide theme value. It uses the same RLS and revokes as the existing tables, so only the service role key can reach it. Exact table shape is left to the builder.
- Admin write goes through a new route guarded by `denyUnlessAdmin(request, { write: true })`, and rejects any slug other than the three above.
- The public `/api/site-config` response gains the theme slug, and `getSiteConfig` keeps its 5-second cache, invalidated on save.
- Existing behavior is preserved: if the database is unavailable the site keeps the last known theme, otherwise Midnight. If the migration has not been applied, module toggles must keep working and the theme falls back to Midnight.
- `SiteConfigProvider` applies the theme by setting `data-theme` on `<html>`, so open tabs update within its existing 15-second refresh and on window focus.
- Avoiding flash: `next.config.mjs` enables `cacheComponents`, so the root layout should not simply read the database. The suggested approach is for `proxy.js` to set a theme cookie and a small blocking inline script to apply it before first paint. The builder must read `node_modules/next/dist/docs/` first, as `frontend/AGENTS.md` requires, and may choose another approach that meets the no-flash goal, including for first-time visitors.

## Making everything themeable

- Colors are hardcoded in about 20 components and in `globals.css` (4,243 lines). `#38bdf8` alone appears 110 times.
- Replace them with semantic CSS variables defined per `[data-theme]`.
- Recharts, SVG and inline styles can take `var(--token)` directly.
- Canvas code (`OsmSignalMap.js`, `WorldHeatmap.js`) and any other JS-driven drawing cannot read CSS variables directly. It must read resolved token values and redraw when the theme changes.
- `CityGrid3D.js` and `DigitalTwin3D.js` must also follow the theme. Check how each one renders before planning its change.
- OSM base map styling must remain readable in the light theme.
- The fonts for all three themes need to load without slowing the default. Loading only the active theme's fonts is preferred.

## Redesign direction

- One design system across all modules, built on the shared tokens: type scale, spacing, panels, buttons, tables, form controls, tabs, badges, dropdowns, modals, charts.
- Move away from the heavy neumorphic shadows, gradient header bars, tracked-out uppercase eyebrow pills and identical card grids.
- Memorable element: an animated junction mesh with a lit green-wave path as the Overview centrepiece, in place of the current header's layout. It respects reduced motion and takes its surfaces and type from the active theme. The owner saw this in the mockups and did not object.
- The mesh is an illustration, not live measurements, and its wording must say or clearly imply that, because the site also presents measured benchmarks. It needs no new data source. (Builder's call.)
- The hero is the mesh plus the existing product name and method line. Everything the current header shows stays visible: "Traffic Swarm Intelligence Lab", the method line, the simulation status, the version and the supported grid sizes. The mockup's headline, KPI tiles and button were sample content. KPIs and run controls stay in their own toggleable sections, so the hero always shows and duplicates nothing. (Builder's call.)
- The green wave is drawn in signal green in all three themes, following the rule that signal colors keep their meaning. This differs from the amber and teal wave in the mockups. (Builder's call.)
- Accents and status colors use separate tokens. Night Road keeps amber as its brand accent, so its warning state must differ by more than hue, such as an icon or label. Survey Map's danger color must be clearly distinct from its orange secondary accent. (Builder's call.)
- Other module layouts are left to the builder, but each module's existing sections must remain individually toggleable through `useSections`, using the same section slugs from `001_admin_panel.sql`.
- Quality floor: responsive down to phone width, visible keyboard focus, reduced motion respected, readable contrast in all three themes.

## Constraints

- Next.js 16.4 with non-standard conventions. Read the bundled docs before writing code.
- No new UI framework. Build on the existing plain CSS, `lucide-react` and `recharts`.
- `npm test` and `next build` must pass. Add tests for the theme route (auth, slug validation, fallback), following `tests/admin.e2e.test.mjs`.
- The owner must run the new migration on Supabase, so document it in `docs/ADMIN_PANEL_DEPLOYMENT.md`.

## Left to the builder

- The file structure of the CSS, token names, and the exact table shape.
- Layouts inside each module, within the rules above.
- Order of work. It should be incremental, so the site stays working between steps.
