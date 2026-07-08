import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { LineFeature, MapFeature, PointFeature, PolygonFeature, Position } from '../osm';
import type { LayerDiagnostics } from './tileSource';

interface GeoJSONGeometry {
  type: string;
  coordinates: unknown;
}

interface GeoJSONFeatureLike {
  id?: number | string;
  properties?: Record<string, string | number | boolean | null>;
  geometry: GeoJSONGeometry;
}

interface MutableLayerStat {
  features: number;
  points: number;
  lines: number;
  polygons: number;
  sampleKeys: Set<string>;
}

const SUPPORTED_LAYERS = new Set([
  'water',
  'waterway',
  'landuse',
  'landcover',
  'park',
  'natural',
  'building',
  'buildings',
  'roads',
  'transportation',
  'transportation_name',
  'transit',
  'pois',
  'poi',
  'places',
  'place',
  'boundaries',
  'boundary',
  'physical_line',
]);

function stringValue(
  properties: Record<string, string | number | boolean | null>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (value === undefined || value === null) {
      continue;
    }

    return String(value);
  }

  return undefined;
}

function toTagRecord(properties: Record<string, string | number | boolean | null>): Record<string, string> {
  const tags: Record<string, string> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) {
      continue;
    }

    tags[key] = String(value);
  }

  return tags;
}

function normalizeRoadKind(kind: string | undefined): string | undefined {
  if (!kind) {
    return undefined;
  }

  const normalized = kind.toLowerCase();

  if (['motorway', 'trunk', 'primary'].includes(normalized)) {
    return 'primary';
  }

  if (['secondary', 'tertiary', 'residential', 'service', 'street', 'minor'].includes(normalized)) {
    return 'secondary';
  }

  if (['path', 'footway', 'cycleway', 'steps', 'track', 'pedestrian'].includes(normalized)) {
    return 'path';
  }

  if (['rail', 'railway', 'tram', 'subway', 'light_rail', 'transit'].includes(normalized)) {
    return 'rail';
  }

  return normalized;
}

function buildNormalizedTags(
  layerName: string,
  properties: Record<string, string | number | boolean | null>,
): Record<string, string> {
  const tags = toTagRecord(properties);
  const normalizedLayer = layerName.toLowerCase();
  const kind = stringValue(
    properties,
    'kind_detail',
    'kind',
    'class',
    'type',
    'subclass',
    'pmap:kind_detail',
    'pmap:kind',
  );

  tags.source_layer = layerName;

  if (normalizedLayer === 'water') {
    tags.natural = tags.natural ?? 'water';
    tags.water = tags.water ?? (kind ? kind.toLowerCase() : 'water');
  }

  if (normalizedLayer === 'waterway') {
    tags.waterway = tags.waterway ?? (kind ? kind.toLowerCase() : 'stream');
  }

  if (normalizedLayer === 'buildings' || normalizedLayer === 'building') {
    tags.building = tags.building ?? 'yes';
  }

  if (
    normalizedLayer === 'roads' ||
    normalizedLayer === 'transportation' ||
    normalizedLayer === 'transportation_name' ||
    normalizedLayer === 'transit'
  ) {
    const roadKind = normalizeRoadKind(kind ?? tags.highway ?? tags.railway);
    if (roadKind === 'rail') {
      tags.railway = tags.railway ?? 'tram';
    } else if (roadKind) {
      tags.highway = tags.highway ?? roadKind;
    }
  }

  if (normalizedLayer === 'landuse' || normalizedLayer === 'landcover' || normalizedLayer === 'park') {
    const areaKind = (kind ?? '').toLowerCase();
    if (
      normalizedLayer === 'park' ||
      ['park', 'garden', 'grass', 'meadow', 'recreation_ground', 'pitch'].includes(areaKind)
    ) {
      tags.leisure = tags.leisure ?? 'park';
    } else if (['forest', 'wood'].includes(areaKind)) {
      tags.natural = tags.natural ?? 'wood';
    } else if (['farmland', 'allotments', 'orchard', 'vineyard'].includes(areaKind)) {
      tags.landuse = tags.landuse ?? 'farmland';
    }
  }

  if (normalizedLayer === 'natural') {
    const naturalKind = (kind ?? '').toLowerCase();
    if (['forest', 'wood'].includes(naturalKind)) {
      tags.natural = tags.natural ?? 'wood';
    } else if (['water', 'lake', 'river'].includes(naturalKind)) {
      tags.natural = tags.natural ?? 'water';
    }
  }

  if (normalizedLayer === 'boundaries' || normalizedLayer === 'boundary') {
    tags.boundary = tags.boundary ?? 'administrative';
  }

  if (normalizedLayer === 'physical_line') {
    const lineKind = (kind ?? '').toLowerCase();
    if (['river', 'stream', 'canal'].includes(lineKind)) {
      tags.waterway = tags.waterway ?? 'stream';
    } else {
      tags.boundary = tags.boundary ?? 'administrative';
    }
  }

  if (normalizedLayer === 'pois' || normalizedLayer === 'poi') {
    const poiKind = (kind ?? '').toLowerCase();
    if (['cafe', 'coffee'].includes(poiKind)) {
      tags.amenity = tags.amenity ?? 'cafe';
    } else if (['station', 'train_station', 'subway_station', 'bus', 'rail'].includes(poiKind)) {
      tags.railway = tags.railway ?? 'station';
    } else if (['museum'].includes(poiKind)) {
      tags.tourism = tags.tourism ?? 'museum';
    } else if (['viewpoint', 'peak'].includes(poiKind)) {
      tags.tourism = tags.tourism ?? 'viewpoint';
    } else if (['hospital'].includes(poiKind)) {
      tags.amenity = tags.amenity ?? 'hospital';
    }
  }

  if (normalizedLayer === 'place' || normalizedLayer === 'places') {
    tags.place = tags.place ?? (kind ? kind.toLowerCase() : 'city');
  }

  return tags;
}

function appendPointFeatures(
  target: MapFeature[],
  coordinates: unknown,
  idBase: string,
  name: string | undefined,
  tags: Record<string, string>,
): void {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return;
  }

  const [lon, lat] = coordinates as [number, number];
  target.push({
    id: idBase,
    type: 'point',
    name,
    tags,
    coordinates: [lon, lat],
  } satisfies PointFeature);
}

function appendLineFeatures(
  target: MapFeature[],
  coordinates: unknown,
  idBase: string,
  name: string | undefined,
  tags: Record<string, string>,
): void {
  if (!Array.isArray(coordinates)) {
    return;
  }

  const line = coordinates as Position[];
  if (line.length < 2) {
    return;
  }

  target.push({
    id: idBase,
    type: 'line',
    name,
    tags,
    coordinates: line,
  } satisfies LineFeature);
}

function appendPolygonFeatures(
  target: MapFeature[],
  coordinates: unknown,
  idBase: string,
  name: string | undefined,
  tags: Record<string, string>,
): void {
  if (!Array.isArray(coordinates)) {
    return;
  }

  const rings = coordinates as Position[][];
  if (!rings.length) {
    return;
  }

  target.push({
    id: idBase,
    type: 'polygon',
    name,
    tags,
    coordinates: rings,
  } satisfies PolygonFeature);
}

function normalizeFeature(
  target: MapFeature[],
  layerName: string,
  tileId: string,
  feature: GeoJSONFeatureLike,
): void {
  const properties = feature.properties ?? {};
  const tags = buildNormalizedTags(layerName, properties);
  const name = stringValue(properties, 'name', 'name_en', 'name:latin');
  const featureId = feature.id ? `${layerName}:${feature.id}` : `${layerName}:${tileId}:${target.length}`;
  const geometryType = feature.geometry.type;

  if (geometryType === 'Point') {
    appendPointFeatures(target, feature.geometry.coordinates, featureId, name, tags);
    return;
  }

  if (geometryType === 'MultiPoint' && Array.isArray(feature.geometry.coordinates)) {
    (feature.geometry.coordinates as unknown[]).forEach((coordinate, index) => {
      appendPointFeatures(target, coordinate, `${featureId}:${index}`, name, tags);
    });
    return;
  }

  if (geometryType === 'LineString') {
    appendLineFeatures(target, feature.geometry.coordinates, featureId, name, tags);
    return;
  }

  if (geometryType === 'MultiLineString' && Array.isArray(feature.geometry.coordinates)) {
    (feature.geometry.coordinates as unknown[]).forEach((line, index) => {
      appendLineFeatures(target, line, `${featureId}:${index}`, name, tags);
    });
    return;
  }

  if (geometryType === 'Polygon') {
    appendPolygonFeatures(target, feature.geometry.coordinates, featureId, name, tags);
    return;
  }

  if (geometryType === 'MultiPolygon' && Array.isArray(feature.geometry.coordinates)) {
    (feature.geometry.coordinates as unknown[]).forEach((polygon, index) => {
      appendPolygonFeatures(target, polygon, `${featureId}:${index}`, name, tags);
    });
  }
}

function ensureLayerStat(
  stats: Map<string, MutableLayerStat>,
  layerName: string,
): MutableLayerStat {
  const existing = stats.get(layerName);
  if (existing) {
    return existing;
  }

  const created: MutableLayerStat = {
    features: 0,
    points: 0,
    lines: 0,
    polygons: 0,
    sampleKeys: new Set<string>(),
  };
  stats.set(layerName, created);
  return created;
}

export function createLayerStats(): Map<string, MutableLayerStat> {
  return new Map<string, MutableLayerStat>();
}

export function decodeVectorTile(
  tileData: ArrayBuffer,
  x: number,
  y: number,
  z: number,
  features: MapFeature[],
  layerStats: Map<string, MutableLayerStat>,
): number {
  const tile = new VectorTile(new PbfReader(tileData));
  let decodedFeatures = 0;

  for (const [layerName, layer] of Object.entries(tile.layers)) {
    const stat = ensureLayerStat(layerStats, layerName);

    for (let index = 0; index < layer.length; index += 1) {
      const vectorFeature = layer.feature(index);
      const geojson = vectorFeature.toGeoJSON(x, y, z) as GeoJSONFeatureLike;

      stat.features += 1;
      decodedFeatures += 1;

      if (geojson.geometry.type.includes('Point')) {
        stat.points += 1;
      } else if (geojson.geometry.type.includes('Line')) {
        stat.lines += 1;
      } else if (geojson.geometry.type.includes('Polygon')) {
        stat.polygons += 1;
      }

      Object.keys(geojson.properties ?? {})
        .slice(0, 8)
        .forEach((key) => stat.sampleKeys.add(key));

      if (!SUPPORTED_LAYERS.has(layerName.toLowerCase())) {
        continue;
      }

      normalizeFeature(features, layerName, `${z}/${x}/${y}`, geojson);
    }
  }

  return decodedFeatures;
}

export function finalizeLayerStats(stats: Map<string, MutableLayerStat>): LayerDiagnostics[] {
  return Array.from(stats.entries())
    .map(([layerName, value]) => ({
      layerName,
      features: value.features,
      points: value.points,
      lines: value.lines,
      polygons: value.polygons,
      sampleKeys: Array.from(value.sampleKeys).sort().slice(0, 8),
    }))
    .sort((left, right) => right.features - left.features);
}
