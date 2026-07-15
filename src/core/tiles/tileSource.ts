import type { BBox, MapFeature } from '../osm';
import { sampleMap } from '../sampleMap';

export interface TileRequest {
  bbox?: BBox;
  center?: {
    lat: number;
    lon: number;
  };
  zoomHint: number;
  roadZoomHint?: number;
  tileSpan?: number;
}

export interface LayerDiagnostics {
  layerName: string;
  features: number;
  points: number;
  lines: number;
  polygons: number;
  sampleKeys: string[];
}

export interface SourceDiagnostics {
  archiveName?: string;
  archiveBounds?: BBox;
  archiveCenter?: {
    lon: number;
    lat: number;
    zoom: number;
  };
  zoom: number;
  roadZoom?: number;
  tileCount: number;
  fetchedTileCount: number;
  totalDecodedFeatures: number;
  layerStats: LayerDiagnostics[];
}

export interface LoadedSourceData {
  id: string;
  label: string;
  title: string;
  bbox: BBox;
  features: MapFeature[];
  diagnostics?: SourceDiagnostics;
}

export interface TileSource {
  id: string;
  label: string;
  load(request: TileRequest): Promise<LoadedSourceData>;
}

export class DemoTileSource implements TileSource {
  id = 'demo';
  label = 'Seattle-inspired demo';

  async load(_request: TileRequest): Promise<LoadedSourceData> {
    return {
      id: sampleMap.id,
      label: this.label,
      title: sampleMap.name,
      bbox: sampleMap.bbox,
      features: sampleMap.features,
      diagnostics: {
        zoom: _request.zoomHint,
        roadZoom: _request.roadZoomHint ?? _request.zoomHint,
        tileCount: 0,
        fetchedTileCount: 0,
        totalDecodedFeatures: sampleMap.features.length,
        layerStats: [],
      },
    };
  }
}
