// The CSS tokens the 3D scene reads, and their conversion to Cesium values. Values live in app/styles/tokens.css.
export const SCENE_TOKENS = [
  '--scene-bg', '--scene-ground', '--scene-basemap-alpha', '--scene-atmosphere', '--scene-road-casing', '--scene-road-center',
  '--scene-vehicle', '--scene-heat-low', '--scene-heat-mid', '--scene-heat-high',
  '--accent', '--bg-surface', '--text-primary', '--status-danger', '--signal-green', '--signal-amber', '--signal-red', '--map-base', '--font-main',
];

export const hasSceneTokens = tokens => SCENE_TOKENS.every(name => !!tokens[name]);

export function toSceneTheme(tokens, Color) {
  const color = name => Color.fromCssColorString(tokens[name]);
  return {
    background: color('--scene-bg'),
    ground: color('--scene-ground'),
    basemapAlpha: Number(tokens['--scene-basemap-alpha']),
    atmosphere: Number(tokens['--scene-atmosphere']) > 0,
    mapBase: tokens['--map-base'],
    font: tokens['--font-main'],
    roadCasing: color('--scene-road-casing'),
    roadCenter: color('--scene-road-center'),
    vehicle: color('--scene-vehicle'),
    emergency: color('--status-danger'),
    marker: color('--accent'),
    markerOutline: color('--bg-surface'),
    label: color('--text-primary'),
    signals: { green: color('--signal-green'), amber: color('--signal-amber'), red: color('--signal-red') },
    heat: [color('--scene-heat-low'), color('--scene-heat-mid'), color('--scene-heat-high')],
  };
}
