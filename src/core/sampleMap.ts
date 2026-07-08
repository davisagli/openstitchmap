import type { BBox, MapFeature, Position } from './osm';

const bbox = {
  minLon: -122.3568,
  minLat: 47.608,
  maxLon: -122.3292,
  maxLat: 47.6256,
} satisfies BBox;

function box(minLon: number, minLat: number, maxLon: number, maxLat: number): Position[][] {
  return [[
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]];
}

const features: MapFeature[] = [
    {
      id: 'elliott-bay',
      name: 'Elliott Bay',
      type: 'polygon',
      tags: { natural: 'water' },
      coordinates: [[
        [-122.3444, 47.608],
        [-122.3292, 47.608],
        [-122.3292, 47.6256],
        [-122.3396, 47.6256],
        [-122.3405, 47.6222],
        [-122.3415, 47.6185],
        [-122.3432, 47.6134],
        [-122.3444, 47.608],
      ]],
    },
    {
      id: 'seattle-center-lawn',
      name: 'Center Lawn',
      type: 'polygon',
      tags: { leisure: 'park' },
      coordinates: box(-122.3539, 47.6191, -122.3483, 47.6243),
    },
    {
      id: 'denny-green',
      name: 'Denny Green',
      type: 'polygon',
      tags: { natural: 'wood' },
      coordinates: box(-122.3479, 47.6147, -122.3433, 47.6188),
    },
    {
      id: 'p-patch',
      name: 'Market P-Patch',
      type: 'polygon',
      tags: { landuse: 'farmland' },
      coordinates: box(-122.3552, 47.6092, -122.3501, 47.6121),
    },
    {
      id: 'market-hall',
      name: 'Pike Hall',
      type: 'polygon',
      tags: { building: 'yes' },
      coordinates: box(-122.3429, 47.6089, -122.3397, 47.6124),
    },
    {
      id: 'needle-studio',
      name: 'Needle Studio',
      type: 'polygon',
      tags: { building: 'yes' },
      coordinates: box(-122.3528, 47.6201, -122.3496, 47.6227),
    },
    {
      id: 'clinic-block',
      name: 'Belltown Clinic',
      type: 'polygon',
      tags: { building: 'yes' },
      coordinates: box(-122.3505, 47.6141, -122.3478, 47.6167),
    },
    {
      id: 'elliott-way',
      name: 'Elliott Way',
      type: 'line',
      tags: { highway: 'primary' },
      coordinates: [
        [-122.3563, 47.611],
        [-122.3497, 47.6114],
        [-122.3445, 47.6118],
        [-122.3394, 47.6122],
      ],
    },
    {
      id: 'broad-street',
      name: 'Broad Street',
      type: 'line',
      tags: { highway: 'secondary' },
      coordinates: [
        [-122.3557, 47.6208],
        [-122.3498, 47.6206],
        [-122.3434, 47.6202],
      ],
    },
    {
      id: 'waterfront-trail',
      name: 'Waterfront Trail',
      type: 'line',
      tags: { highway: 'path' },
      coordinates: [
        [-122.3538, 47.6242],
        [-122.3507, 47.6202],
        [-122.3474, 47.6161],
        [-122.3444, 47.6121],
      ],
    },
    {
      id: 'monorail',
      name: 'Monorail',
      type: 'line',
      tags: { railway: 'tram' },
      coordinates: [
        [-122.3534, 47.6236],
        [-122.3494, 47.6198],
        [-122.3455, 47.6163],
        [-122.3412, 47.6129],
      ],
    },
    {
      id: 'pike-runoff',
      name: 'Pike Runoff',
      type: 'line',
      tags: { waterway: 'stream' },
      coordinates: [
        [-122.3504, 47.6187],
        [-122.3466, 47.6166],
        [-122.3427, 47.6147],
        [-122.3392, 47.6131],
      ],
    },
    {
      id: 'belltown-boundary',
      name: 'Belltown Boundary',
      type: 'line',
      tags: { boundary: 'administrative', admin_level: '10' },
      coordinates: [
        [-122.3558, 47.6247],
        [-122.3485, 47.6238],
        [-122.3416, 47.6242],
        [-122.3331, 47.6236],
      ],
    },
    {
      id: 'cafe-poi',
      name: 'Pike Street Roastery',
      type: 'point',
      tags: { amenity: 'cafe' },
      coordinates: [-122.3416, 47.6112],
    },
    {
      id: 'station-poi',
      name: 'Westlake Terminal',
      type: 'point',
      tags: { railway: 'station' },
      coordinates: [-122.3447, 47.6139],
    },
    {
      id: 'museum-poi',
      name: 'Needle Studio',
      type: 'point',
      tags: { tourism: 'museum' },
      coordinates: [-122.3511, 47.6215],
    },
    {
      id: 'viewpoint-poi',
      name: 'Olympic View',
      type: 'point',
      tags: { tourism: 'viewpoint' },
      coordinates: [-122.3387, 47.6199],
    },
    {
      id: 'hospital-poi',
      name: 'Belltown Clinic',
      type: 'point',
      tags: { amenity: 'hospital' },
      coordinates: [-122.3491, 47.6152],
    },
];

export const sampleMap = {
  id: 'seattle-waterfront',
  name: 'Seattle Waterfront',
  bbox,
  features,
};
