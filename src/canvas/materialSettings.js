export const MIN_CROWDED_HALF_ANGLE = 8 * (Math.PI / 180);
export const CREATE_DURATION = 460;
export const CONNECTION_CREATE_DURATION = 350;
export const CONNECTION_CREATE_CONTACT_PROGRESS = 0.7;
export const CONNECTION_CREATE_RETURN_DELAY = 72;
export const CONNECTION_POP_DURATION = 520;
export const CONNECTION_POP_RUPTURE_PROGRESS = 0.12;
export const CONNECTION_POP_TRAVEL_PROGRESS = 0.24;
export const WOBBLE_DURATION = 640;

export const DEFAULT_MATERIAL_SETTINGS = {
  viscosity: 0.8,
  elasticity: 0.05,
  repulsion: 0.95,
  minimumDistance: 0.8,
  maximumDistance: 1.2,
  damping: 0.6,
  bridgeWidth: 0.38,
  flare: 0.23,
  filletReach: 0.16,
};

export const PAPER_MATERIAL_SETTINGS = {
  ...DEFAULT_MATERIAL_SETTINGS,
  bridgeWidth: 0.62,
  flare: 0.29,
  filletReach: 0.22,
};
