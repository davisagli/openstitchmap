import type { BBox, MapFeature } from '../osm';
import { bboxToTileRange, centeredTileRange, tileRangeToBBox, type TileRange } from './mercator';
import type { LoadedSourceData, SourceDiagnostics, TileRequest, TileSource } from './tileSource';
import { createLayerStats, decodeVectorTile, finalizeLayerStats, isRoadSourceLayer } from './vectorTileDecoder';

interface TileJsonLike {
  attribution?: string;
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  maxzoom?: number;
  minzoom?: number;
  name?: string;
  tiles: string[];
}

function clampZoom(value: number, tileJson: TileJsonLike): number {
  const minZoom = tileJson.minzoom ?? 0;
  const maxZoom = tileJson.maxzoom ?? 14;
  return Math.max(minZoom, Math.min(maxZoom, value));
}

function replaceTileTemplate(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

function archiveBounds(tileJson: TileJsonLike): BBox | undefined {
  if (!tileJson.bounds) {
    return undefined;
  }

  const [minLon, minLat, maxLon, maxLat] = tileJson.bounds;
  return { minLon, minLat, maxLon, maxLat };
}

function tileCoordinatesForRange(tileRange: TileRange): Array<{ x: number; y: number }> {
  const tileCoordinates: Array<{ x: number; y: number }> = [];
  for (let x = tileRange.minX; x <= tileRange.maxX; x += 1) {
    for (let y = tileRange.minY; y <= tileRange.maxY; y += 1) {
      tileCoordinates.push({ x, y });
    }
  }
  return tileCoordinates;
}

export class HostedVectorTileSource implements TileSource {
  id = 'hosted';
  label = 'Hosted vector tiles';

  constructor(
    private readonly tileJsonUrl: string,
    private readonly displayName: string,
  ) {}

  async load(request: TileRequest): Promise<LoadedSourceData> {
    const tileJsonResponse = await fetch(this.tileJsonUrl);
    if (!tileJsonResponse.ok) {
      throw new Error(`TileJSON request failed with ${tileJsonResponse.status}.`);
    }

    const tileJson = (await tileJsonResponse.json()) as TileJsonLike;
    const center = request.center ?? {
      lon: tileJson.center?.[0] ?? 0,
      lat: tileJson.center?.[1] ?? 0,
    };
    const zoom = clampZoom(request.zoomHint, tileJson);
    const roadZoom = request.roadZoomHint === undefined ? zoom : clampZoom(request.roadZoomHint, tileJson);
    const tileRange = request.bbox
      ? bboxToTileRange(request.bbox, zoom)
      : centeredTileRange(center.lon, center.lat, zoom, request.tileSpan ?? 2);
    const resolvedBBox = request.bbox ?? tileRangeToBBox(tileRange);
    const features: MapFeature[] = [];
    const layerStats = createLayerStats();
    let fetchedTileCount = 0;
    let totalDecodedFeatures = 0;
    const template = tileJson.tiles[0];

    const fetchRange = async (
      range: TileRange,
      layerFilter?: (layerName: string) => boolean,
    ): Promise<{ tileCount: number; fetchedTileCount: number; totalDecodedFeatures: number }> => {
      const tileCoordinates = tileCoordinatesForRange(range);
      let rangeFetchedTileCount = 0;
      let rangeDecodedFeatures = 0;

      await Promise.all(
        tileCoordinates.map(async ({ x, y }) => {
          const tileResponse = await fetch(replaceTileTemplate(template, range.z, x, y));
          if (!tileResponse.ok) {
            return;
          }

          rangeFetchedTileCount += 1;
          const tileData = await tileResponse.arrayBuffer();
          rangeDecodedFeatures += decodeVectorTile(tileData, x, y, range.z, features, layerStats, {
            layerFilter,
          });
        }),
      );

      return {
        tileCount: tileCoordinates.length,
        fetchedTileCount: rangeFetchedTileCount,
        totalDecodedFeatures: rangeDecodedFeatures,
      };
    };

    const baseFilter = roadZoom === zoom ? undefined : (layerName: string) => !isRoadSourceLayer(layerName);
    const baseResult = await fetchRange(tileRange, baseFilter);
    let tileCount = baseResult.tileCount;
    fetchedTileCount += baseResult.fetchedTileCount;
    totalDecodedFeatures += baseResult.totalDecodedFeatures;

    if (roadZoom !== zoom) {
      const roadRange = bboxToTileRange(resolvedBBox, roadZoom);
      const roadResult = await fetchRange(roadRange, isRoadSourceLayer);
      tileCount += roadResult.tileCount;
      fetchedTileCount += roadResult.fetchedTileCount;
      totalDecodedFeatures += roadResult.totalDecodedFeatures;
    }

    const diagnostics: SourceDiagnostics = {
      archiveName: tileJson.name ?? this.displayName,
      archiveBounds: archiveBounds(tileJson),
      archiveCenter: tileJson.center
        ? {
            lon: tileJson.center[0],
            lat: tileJson.center[1],
            zoom: tileJson.center[2],
          }
        : undefined,
      zoom,
      roadZoom,
      tileCount,
      fetchedTileCount,
      totalDecodedFeatures,
      layerStats: finalizeLayerStats(layerStats),
    };

    return {
      id: this.id,
      label: this.displayName,
      title: tileJson.name ?? this.displayName,
      bbox: resolvedBBox,
      features,
      diagnostics,
    };
  }
}
