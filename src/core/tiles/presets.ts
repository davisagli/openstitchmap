export interface AreaPreset {
  center: {
    lat: number;
    lon: number;
  };
  id: string;
  label: string;
  tileSpan: number;
  zoom: number;
}

export const areaPresets: AreaPreset[] = [
  {
    id: 'seattle-waterfront',
    label: 'Seattle Waterfront',
    center: { lon: -122.3428, lat: 47.6076 },
    zoom: 14,
    tileSpan: 1,
  },
  {
    id: 'pike-place',
    label: 'Pike Place Market',
    center: { lon: -122.3425, lat: 47.6095 },
    zoom: 14,
    tileSpan: 1,
  },
  {
    id: 'seattle-center',
    label: 'Seattle Center',
    center: { lon: -122.3505, lat: 47.6211 },
    zoom: 14,
    tileSpan: 1,
  },
];
