// The three site themes. Shared by server and client, and kept in step with db/migrations/002_site_theme.sql.
export const DEFAULT_THEME = 'midnight';

// `fonts` is null for midnight because the root layout always loads its fonts.
export const THEMES = [
  { slug: 'midnight', name: 'Midnight Command', description: 'Navy with cyan and emerald. The default look.', fonts: null },
  {
    slug: 'night-road', name: 'Night Road', description: 'Asphalt grey and signal amber, with road-sign type.',
    fonts: 'https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600;700&display=swap',
  },
  {
    slug: 'survey-map', name: 'Survey Map', description: 'A light theme like a printed city map.',
    fonts: 'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600;6..72,700&family=Instrument+Sans:wght@400;500;600;700&display=swap',
  },
];

export const isThemeSlug = value => THEMES.some(t => t.slug === value);
export const normalizeTheme = value => (isThemeSlug(value) ? value : DEFAULT_THEME);
