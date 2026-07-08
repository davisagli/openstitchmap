export type Position = [lon: number, lat: number];

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface BaseFeature {
  id: string;
  name?: string;
  tags: Record<string, string>;
}

export interface PolygonFeature extends BaseFeature {
  type: 'polygon';
  coordinates: Position[][];
}

export interface LineFeature extends BaseFeature {
  type: 'line';
  coordinates: Position[];
}

export interface PointFeature extends BaseFeature {
  type: 'point';
  coordinates: Position;
}

export type MapFeature = PolygonFeature | LineFeature | PointFeature;
