export type FillStyleId =
  | 'ground'
  | 'water'
  | 'park'
  | 'forest'
  | 'farmland'
  | 'building';

export type LineStyleId =
  | 'primaryRoad'
  | 'secondaryRoad'
  | 'path'
  | 'rail'
  | 'stream'
  | 'boundary';

export type MarkerStyleId =
  | 'cafe'
  | 'station'
  | 'viewpoint'
  | 'museum'
  | 'hospital';

export interface FillStyle {
  id: FillStyleId;
  label: string;
  color: string;
  floss: string;
  symbol: string;
  priority: number;
}

export interface LineStyle {
  id: LineStyleId;
  label: string;
  color: string;
  floss: string;
  weight: number;
}

export interface MarkerStyle {
  id: MarkerStyleId;
  label: string;
  color: string;
  floss: string;
  symbol: string;
}

export const fillStyles: Record<FillStyleId, FillStyle> = {
  ground: {
    id: 'ground',
    label: 'Ground',
    color: '#f4ead8',
    floss: 'DMC 3866',
    symbol: '.',
    priority: 0,
  },
  water: {
    id: 'water',
    label: 'Water',
    color: '#78b7d0',
    floss: 'DMC 3760',
    symbol: '~',
    priority: 2,
  },
  park: {
    id: 'park',
    label: 'Park',
    color: '#a4c48d',
    floss: 'DMC 369',
    symbol: '+',
    priority: 3,
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    color: '#4f7c5b',
    floss: 'DMC 3347',
    symbol: '*',
    priority: 4,
  },
  farmland: {
    id: 'farmland',
    label: 'Farmland',
    color: '#d4bc72',
    floss: 'DMC 729',
    symbol: '=',
    priority: 3,
  },
  building: {
    id: 'building',
    label: 'Building',
    color: '#c38762',
    floss: 'DMC 950',
    symbol: '#',
    priority: 7,
  },
};

export const lineStyles: Record<LineStyleId, LineStyle> = {
  primaryRoad: {
    id: 'primaryRoad',
    label: 'Primary Road',
    color: '#d95d39',
    floss: 'DMC 920',
    weight: 2.6,
  },
  secondaryRoad: {
    id: 'secondaryRoad',
    label: 'Secondary Road',
    color: '#f09f54',
    floss: 'DMC 3826',
    weight: 1.8,
  },
  path: {
    id: 'path',
    label: 'Path',
    color: '#7c5f46',
    floss: 'DMC 434',
    weight: 1.3,
  },
  rail: {
    id: 'rail',
    label: 'Rail',
    color: '#3e4853',
    floss: 'DMC 413',
    weight: 1.7,
  },
  stream: {
    id: 'stream',
    label: 'Stream',
    color: '#2b6f88',
    floss: 'DMC 3810',
    weight: 1.6,
  },
  boundary: {
    id: 'boundary',
    label: 'Boundary',
    color: '#8d7867',
    floss: 'DMC 612',
    weight: 1.1,
  },
};

export const markerStyles: Record<MarkerStyleId, MarkerStyle> = {
  cafe: {
    id: 'cafe',
    label: 'Cafe',
    color: '#b6523d',
    floss: 'DMC 920',
    symbol: '•',
  },
  station: {
    id: 'station',
    label: 'Station',
    color: '#2f5f9a',
    floss: 'DMC 336',
    symbol: '•',
  },
  viewpoint: {
    id: 'viewpoint',
    label: 'Viewpoint',
    color: '#6f7c2d',
    floss: 'DMC 730',
    symbol: '•',
  },
  museum: {
    id: 'museum',
    label: 'Museum',
    color: '#835e8c',
    floss: 'DMC 208',
    symbol: '•',
  },
  hospital: {
    id: 'hospital',
    label: 'Hospital',
    color: '#a8374e',
    floss: 'DMC 814',
    symbol: '•',
  },
};
