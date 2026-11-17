const NOOK_TILE_COLORS: Record<string, string> = {
  indigo: '#889DF0', violet: '#B77DEE', purple: '#B77DEE', fuchsia: '#F8A6B2',
  pink: '#F8A6B2', rose: '#FC736D', red: '#FC736D', orange: '#E59266',
  amber: '#F7CD67', lime: '#D1DA49', green: '#8AC68A', emerald: '#82D5BB',
  cyan: '#82D5BB', blue: '#889DF0', slate: '#9A835A',
};

export const getNookAppTileColor = (color?: string): string =>
  (color && NOOK_TILE_COLORS[color]) || NOOK_TILE_COLORS.slate;
