// The three site themes. Shared by server and client, and kept in step with db/migrations/002_site_theme.sql.
export const DEFAULT_THEME = 'midnight';

export const THEMES = [
  { slug: 'midnight', name: 'Midnight Command', description: 'Navy with cyan and emerald. The default look.' },
  { slug: 'night-road', name: 'Night Road', description: 'Asphalt grey and signal amber, with road-sign type.' },
  { slug: 'survey-map', name: 'Survey Map', description: 'A light theme like a printed city map.' },
];

export const isThemeSlug = value => THEMES.some(t => t.slug === value);
export const normalizeTheme = value => (isThemeSlug(value) ? value : DEFAULT_THEME);
