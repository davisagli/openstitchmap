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
    const features: MapFeature[] = [];
    const layerStats = createLayerStats();
    let fetchedTileCount = 0;
    let totalDecodedFeatures = 0;

    const tileCoordinates: Array<{ x: number; y: number }> = [];
    for (let x = tileRange.minX; x <= tileRange.maxX; x += 1) {
      for (let y = tileRange.minY; y <= tileRange.maxY; y += 1) {
        tileCoordinates.push({ x, y });
      }
    }

    await Promise.all(
      tileCoordinates.map(async ({ x, y }) => {
        const tileResponse = await this.archive.getZxy(tileRange.z, x, y);
        if (!tileResponse) {
          return;
        }

        fetchedTileCount += 1;
        totalDecodedFeatures += decodeVectorTile(tileResponse.data, x, y, tileRange.z, features, layerStats);
      }),
    );

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
      tileCount: tileCoordinates.length,
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
