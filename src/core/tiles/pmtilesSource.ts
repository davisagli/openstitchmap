import { PMTiles } from 'pmtiles';
import type { BBox, MapFeature } from '../osm';
import {
  bboxToTileRange,
  centeredTileRange,
  tileRangeToBBox,
  type TileRange,
} from './mercator';
import type {
  LayerDiagnostics,
  LoadedSourceData,
  SourceDiagnostics,
  TileRequest,
  TileSource,
} from './tileSource';
import {
  createLayerStats,
  decodeVectorTile,
  finalizeLayerStats,
  isRoadSourceLayer,
} from './vectorTileDecoder';

interface HeaderLike {
  centerLon: number;
  centerLat: number;
  centerZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

interface MetadataLike {
  name?: string;
}

function rangeForRequest(request: TileRequest, header: HeaderLike): TileRange {
  if (request.bbox) {
    return bboxToTileRange(request.bbox, request.zoomHint);
  }

  return centeredTileRange(
    request.center?.lon ?? header.centerLon,
    request.center?.lat ?? header.centerLat,
    request.zoomHint,
    request.tileSpan ?? 2,
  );
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

export class PMTilesVectorSource implements TileSource {
  id = 'pmtiles';
  label = 'Live PMTiles archive';
  private archive: PMTiles;

  constructor(private url: string) {
    this.archive = new PMTiles(url);
  }

  async load(request: TileRequest): Promise<LoadedSourceData> {
    const header = (await this.archive.getHeader()) as HeaderLike;
    const metadata = (await this.archive.getMetadata()) as MetadataLike;
    const tileRange = rangeForRequest(request, header);
    const resolvedBBox = request.bbox ?? tileRangeToBBox(tileRange);
    const roadZoom = request.roadZoomHint ?? tileRange.z;
    const features: MapFeature[] = [];
    const layerStats = createLayerStats();
    let fetchedTileCount = 0;
    let totalDecodedFeatures = 0;

    const fetchRange = async (
      range: TileRange,
      layerFilter?: (layerName: string) => boolean,
    ): Promise<{ tileCount: number; fetchedTileCount: number; totalDecodedFeatures: number }> => {
      const tileCoordinates = tileCoordinatesForRange(range);
      let rangeFetchedTileCount = 0;
      let rangeDecodedFeatures = 0;

      await Promise.all(
        tileCoordinates.map(async ({ x, y }) => {
          const tileResponse = await this.archive.getZxy(range.z, x, y);
          if (!tileResponse) {
            return;
          }

          rangeFetchedTileCount += 1;
          rangeDecodedFeatures += decodeVectorTile(tileResponse.data, x, y, range.z, features, layerStats, {
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

    const baseFilter = roadZoom === tileRange.z ? undefined : (layerName: string) => !isRoadSourceLayer(layerName);
    const baseResult = await fetchRange(tileRange, baseFilter);
    let tileCount = baseResult.tileCount;
    fetchedTileCount += baseResult.fetchedTileCount;
    totalDecodedFeatures += baseResult.totalDecodedFeatures;

    if (roadZoom !== tileRange.z) {
      const roadResult = await fetchRange(bboxToTileRange(resolvedBBox, roadZoom), isRoadSourceLayer);
      tileCount += roadResult.tileCount;
      fetchedTileCount += roadResult.fetchedTileCount;
      totalDecodedFeatures += roadResult.totalDecodedFeatures;
    }

    const diagnostics: SourceDiagnostics = {
      archiveName: metadata.name,
      archiveBounds: {
        minLon: header.minLon,
        minLat: header.minLat,
        maxLon: header.maxLon,
        maxLat: header.maxLat,
      },
      archiveCenter: {
        lon: header.centerLon,
        lat: header.centerLat,
        zoom: header.centerZoom,
      },
      zoom: tileRange.z,
      roadZoom,
      tileCount,
      fetchedTileCount,
      totalDecodedFeatures,
      layerStats: finalizeLayerStats(layerStats),
    };

    return {
      id: this.id,
      label: this.label,
      title: metadata.name ?? 'PMTiles Pattern',
      bbox: resolvedBBox,
      features,
      diagnostics,
    };
  }
}
