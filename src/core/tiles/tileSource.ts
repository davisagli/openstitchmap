import type { BBox, MapFeature } from '../osm';

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
