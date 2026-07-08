import type { BBox } from '../osm';

export interface TileCoordinate {
  x: number;
  y: number;
  z: number;
}

export interface TileRange {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  z: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampLatitude(lat: number): number {
  return clamp(lat, -85.05112878, 85.05112878);
}

export function lonLatToTile(lon: number, lat: number, zoom: number): TileCoordinate {
  const latRadians = (clampLatitude(lat) * Math.PI) / 180;
  const scale = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRadians) + 1 / Math.cos(latRadians)) / Math.PI) / 2) * scale,
  );

  return {
    x: clamp(x, 0, scale - 1),
    y: clamp(y, 0, scale - 1),
    z: zoom,
  };
}

function tileToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function tileToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function tileToBBox(x: number, y: number, z: number): BBox {
  return {
    minLon: tileToLon(x, z),
    minLat: tileToLat(y + 1, z),
    maxLon: tileToLon(x + 1, z),
    maxLat: tileToLat(y, z),
  };
}

export function tileRangeToBBox(range: TileRange): BBox {
  const topLeft = tileToBBox(range.minX, range.minY, range.z);
  const bottomRight = tileToBBox(range.maxX, range.maxY, range.z);

  return {
    minLon: topLeft.minLon,
    minLat: bottomRight.minLat,
    maxLon: bottomRight.maxLon,
    maxLat: topLeft.maxLat,
  };
}

export function bboxToTileRange(bbox: BBox, zoom: number): TileRange {
  const topLeft = lonLatToTile(bbox.minLon, bbox.maxLat, zoom);
  const bottomRight = lonLatToTile(bbox.maxLon, bbox.minLat, zoom);
  const scale = 2 ** zoom - 1;

  return {
    minX: clamp(Math.min(topLeft.x, bottomRight.x), 0, scale),
    minY: clamp(Math.min(topLeft.y, bottomRight.y), 0, scale),
    maxX: clamp(Math.max(topLeft.x, bottomRight.x), 0, scale),
    maxY: clamp(Math.max(topLeft.y, bottomRight.y), 0, scale),
    z: zoom,
  };
}

export function centeredTileRange(
  lon: number,
  lat: number,
  zoom: number,
  span: number,
): TileRange {
  const center = lonLatToTile(lon, lat, zoom);
  const scale = 2 ** zoom - 1;
  const normalizedSpan = Math.max(1, Math.round(span));
  const before = Math.floor((normalizedSpan - 1) / 2);
  const after = normalizedSpan - before - 1;

  return {
    minX: clamp(center.x - before, 0, scale),
    minY: clamp(center.y - before, 0, scale),
    maxX: clamp(center.x + after, 0, scale),
    maxY: clamp(center.y + after, 0, scale),
    z: zoom,
  };
}
