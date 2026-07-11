import { useDeferredValue, useEffect, useRef, useState, useTransition } from 'react';
import type {
  FormEvent as ReactFormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import './App.css';
import type { BBox, MapFeature, Position } from '../core/osm';
import type { LoadedSourceData } from '../core/tiles/tileSource';
import { HostedVectorTileSource } from '../core/tiles/hostedVectorSource';
import { lonLatToWorld, worldToLonLat } from '../core/tiles/mercator';
import { areaPresets } from '../core/tiles/presets';
import {
  buildPatternDocument,
  classifyLine,
  classifyMarker,
  classifyPolygon,
  compilePatternCells,
  compilePatternOverlays,
  type CompilePatternOptions,
  type LegendEntry,
  type PatternCell,
  type PatternDocument,
  type PatternOverlayData,
} from '../core/pattern/compilePattern';
import {
  curateFeatures,
  type CurateFeaturesResult,
  type DetailLevel,
} from '../core/pattern/curateFeatures';
import { drawChartPreview } from '../render/drawChartPreview';
import { drawStitchPreview } from '../render/drawStitchPreview';
import { exportCanvasPng } from '../render/exporters';

type ViewMode = 'chart' | 'stitched';
type FabricCount = 14 | 16 | 18;

interface PreviewMotion {
  scale: number;
  translateX: number;
  translateY: number;
}

interface Settings {
  center: {
    lat: number;
    lon: number;
  };
  width: number;
  height: number;
  fabricCount: FabricCount;
  detailLevel: DetailLevel;
  roadNetworkDetail: number;
  zoomHint: number;
  pmtilesUrl: string;
}

interface PreparedPatternVariant {
  curation: CurateFeaturesResult;
  options: CompilePatternOptions;
}

interface PreparedViewportData {
  actual: PreparedPatternVariant;
  preview: PreparedPatternVariant;
}

interface CompiledPatternVariant extends PreparedPatternVariant {
  baseCells: PatternCell[][];
  baseOverlays: PatternOverlayData;
  basePattern: PatternDocument;
}

interface CompiledViewportData {
  actual: CompiledPatternVariant;
  preview: CompiledPatternVariant;
  availableLegend: LegendEntry[];
}

interface SearchResult {
  id: string;
  label: string;
  detail: string;
  lat: number;
  lon: number;
  bbox: BBox | null;
}

const HOSTED_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const defaultAreaPreset = areaPresets[0];
const SLIPPY_VIEW_HEIGHT_TILES = 1;
const PREVIEW_OVERSCAN_FACTOR = 1.45;
const PREVIEW_PADDING = 24;
const FABRIC_COUNTS: FabricCount[] = [14, 16, 18];
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

const defaultSettings: Settings = {
  center: defaultAreaPreset.center,
  width: 96,
  height: 72,
  fabricCount: 14,
  detailLevel: 'medium',
  roadNetworkDetail: 18,
  zoomHint: defaultAreaPreset.zoom,
  pmtilesUrl: '',
};

function clampDimension(value: number, fallback: number): number {
  if (Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(180, Math.max(36, Math.round(value)));
}

function inches(stitches: number, fabricCount: number): string {
  return (stitches / fabricCount).toFixed(1);
}

function clampZoom(value: number): number {
  return Math.min(16, Math.max(10, Math.round(value)));
}

function clampRoadNetworkDetail(value: number): number {
  if (Number.isNaN(value)) {
    return defaultSettings.roadNetworkDetail;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

function roadNetworkDetailLabel(value: number): string {
  if (value < 28) {
    return 'Prominent';
  }

  if (value < 62) {
    return 'Balanced';
  }

  return 'Dense';
}

function viewportSpanX(width: number, height: number): number {
  return SLIPPY_VIEW_HEIGHT_TILES * Math.max(0.5, width / Math.max(1, height));
}

function viewportBBox(
  center: { lat: number; lon: number },
  zoom: number,
  width: number,
  height: number,
  overscanFactor = 1,
): BBox {
  const aspectRatio = Math.max(0.5, width / Math.max(1, height));
  const world = lonLatToWorld(center.lon, center.lat, zoom);
  const worldScale = 2 ** zoom;
  const spanY = SLIPPY_VIEW_HEIGHT_TILES * overscanFactor;
  const spanX = spanY * aspectRatio;
  const minX = Math.max(0, Math.min(worldScale, world.x - spanX / 2));
  const maxX = Math.max(0, Math.min(worldScale, world.x + spanX / 2));
  const minY = Math.max(0, Math.min(worldScale, world.y - spanY / 2));
  const maxY = Math.max(0, Math.min(worldScale, world.y + spanY / 2));
  const northWest = worldToLonLat(minX, minY, zoom);
  const southEast = worldToLonLat(maxX, maxY, zoom);

  return {
    minLon: northWest.lon,
    minLat: southEast.lat,
    maxLon: southEast.lon,
    maxLat: northWest.lat,
  };
}

function bboxIntersects(left: BBox, right: BBox): boolean {
  return !(
    left.maxLon < right.minLon ||
    left.minLon > right.maxLon ||
    left.maxLat < right.minLat ||
    left.minLat > right.maxLat
  );
}

function positionsBBox(positions: Position[]): BBox {
  let minLon = positions[0][0];
  let maxLon = positions[0][0];
  let minLat = positions[0][1];
  let maxLat = positions[0][1];

  for (const [lon, lat] of positions) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  return { minLon, minLat, maxLon, maxLat };
}

function featureBBox(feature: MapFeature): BBox {
  if (feature.type === 'point') {
    const [lon, lat] = feature.coordinates;
    return { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat };
  }

  if (feature.type === 'line') {
    return positionsBBox(feature.coordinates);
  }

  return positionsBBox(feature.coordinates.flat());
}

function filterFeaturesToBBox(features: MapFeature[], bbox: BBox): MapFeature[] {
  return features.filter((feature) => bboxIntersects(featureBBox(feature), bbox));
}

function legendEntryKey(entry: Pick<LegendEntry, 'id' | 'mode'>): string {
  return `${entry.mode}:${entry.id}`;
}

function isInteractiveLegendEntry(entry: LegendEntry): boolean {
  return !(entry.mode === 'fill' && entry.id === 'ground');
}

function featureLegendKey(feature: MapFeature): string | null {
  if (feature.type === 'polygon') {
    const style = classifyPolygon(feature);
    return style ? `fill:${style.id}` : null;
  }

  if (feature.type === 'line') {
    const kind = classifyLine(feature);
    return kind ? `line:${kind}` : null;
  }

  const kind = classifyMarker(feature);
  return kind ? `marker:${kind}` : null;
}

function filterFeaturesByLegendSelection(features: MapFeature[], hiddenEntries: Set<string>): MapFeature[] {
  if (!hiddenEntries.size) {
    return features;
  }

  return features.filter((feature) => {
    const key = featureLegendKey(feature);
    return key ? !hiddenEntries.has(key) : true;
  });
}

function hasHiddenLegendMode(hiddenEntries: Set<string>, mode: LegendEntry['mode']): boolean {
  for (const key of hiddenEntries) {
    if (key.startsWith(`${mode}:`)) {
      return true;
    }
  }

  return false;
}

function filterBackstitchesByLegendSelection(
  backstitches: PatternOverlayData['backstitches'],
  hiddenEntries: Set<string>,
) {
  if (!hasHiddenLegendMode(hiddenEntries, 'line')) {
    return backstitches;
  }

  return backstitches.filter((segment) => !hiddenEntries.has(`line:${segment.kind}`));
}

function filterMarkersByLegendSelection(markers: PatternOverlayData['markers'], hiddenEntries: Set<string>) {
  if (!hasHiddenLegendMode(hiddenEntries, 'marker')) {
    return markers;
  }

  return markers.filter((marker) => !hiddenEntries.has(`marker:${marker.kind}`));
}

function buildVisiblePattern(
  variant: CompiledPatternVariant,
  hiddenEntries: Set<string>,
): PatternDocument {
  if (!hiddenEntries.size) {
    return variant.basePattern;
  }

  const backstitches = filterBackstitchesByLegendSelection(variant.baseOverlays.backstitches, hiddenEntries);
  const markers = filterMarkersByLegendSelection(variant.baseOverlays.markers, hiddenEntries);
  const cells = hasHiddenLegendMode(hiddenEntries, 'fill')
    ? compilePatternCells(filterFeaturesByLegendSelection(variant.curation.features, hiddenEntries), variant.options)
    : variant.baseCells;

  return buildPatternDocument({
    title: variant.options.title,
    width: variant.options.width,
    height: variant.options.height,
    bbox: variant.options.bbox,
    cells,
    backstitches,
    markers,
  });
}

function formatSearchDetail(parts: Array<string | null | undefined>): string {
  return parts.filter((part) => part && part.trim().length > 0).join(', ');
}

function parseSearchBBox(raw: unknown): BBox | null {
  if (!Array.isArray(raw) || raw.length < 4) {
    return null;
  }

  const [south, north, west, east] = raw.map((value) => Number(value));
  if ([south, north, west, east].some((value) => Number.isNaN(value))) {
    return null;
  }

  return {
    minLon: west,
    minLat: south,
    maxLon: east,
    maxLat: north,
  };
}

function searchBBoxToZoom(
  bbox: BBox | null,
  width: number,
  height: number,
  fallbackZoom: number,
): number {
  if (!bbox) {
    return fallbackZoom;
  }

  const northWest = lonLatToWorld(bbox.minLon, bbox.maxLat, 0);
  const southEast = lonLatToWorld(bbox.maxLon, bbox.minLat, 0);
  const bboxWidth = Math.max(0.00001, Math.abs(southEast.x - northWest.x));
  const bboxHeight = Math.max(0.00001, Math.abs(southEast.y - northWest.y));
  const fitScale = Math.min(
    (viewportSpanX(width, height) * 0.82) / bboxWidth,
    (SLIPPY_VIEW_HEIGHT_TILES * 0.82) / bboxHeight,
  );

  return clampZoom(Math.floor(Math.log2(Math.max(fitScale, 1e-6))));
}

function normalizeSearchResult(value: unknown): SearchResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const result = value as Record<string, unknown>;
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return null;
  }

  const displayName = typeof result.display_name === 'string' ? result.display_name : 'Unnamed place';
  const name =
    typeof result.name === 'string' && result.name.trim().length > 0
      ? result.name
      : displayName.split(',')[0]?.trim() || displayName;
  const address =
    typeof result.address === 'object' && result.address
      ? (result.address as Record<string, unknown>)
      : null;
  const detail = formatSearchDetail([
    typeof result.type === 'string' ? result.type : null,
    address
      ? formatSearchDetail([
          typeof address.city === 'string'
            ? address.city
            : typeof address.town === 'string'
              ? address.town
              : typeof address.village === 'string'
                ? address.village
                : null,
          typeof address.state === 'string' ? address.state : null,
          typeof address.country === 'string' ? address.country : null,
        ])
      : displayName.split(',').slice(1).join(',').trim(),
  ]);

  return {
    id:
      typeof result.place_id === 'number' || typeof result.place_id === 'string'
        ? String(result.place_id)
        : `${lat},${lon}`,
    label: name,
    detail: detail || displayName,
    lat,
    lon,
    bbox: parseSearchBBox(result.boundingbox),
  };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startMotion: PreviewMotion | null;
    startX: number;
    startY: number;
  } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('chart');
  const [isDraggingPreview, setIsDraggingPreview] = useState(false);
  const [previewMotion, setPreviewMotion] = useState<PreviewMotion | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const deferredSettings = useDeferredValue(settings);
  const [sourceData, setSourceData] = useState<LoadedSourceData | null>(null);
  const [preparedViewport, setPreparedViewport] = useState<PreparedViewportData | null>(null);
  const [compiledViewport, setCompiledViewport] = useState<CompiledViewportData | null>(null);
  const [curation, setCuration] = useState<CurateFeaturesResult | null>(null);
  const [availableLegend, setAvailableLegend] = useState<LegendEntry[]>([]);
  const [hiddenLegendEntries, setHiddenLegendEntries] = useState<Set<string>>(new Set());
  const [pattern, setPattern] = useState<PatternDocument | null>(null);
  const [previewPattern, setPreviewPattern] = useState<PatternDocument | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isRefreshingPreview, setIsRefreshingPreview] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'done'>('idle');

  useEffect(() => {
    let cancelled = false;
    const source = new HostedVectorTileSource(HOSTED_TILEJSON_URL, 'OpenFreeMap');

    setSourceError(null);
    setIsRefreshingPreview(true);

    source
      .load({
        bbox: viewportBBox(
          deferredSettings.center,
          deferredSettings.zoomHint,
          deferredSettings.width,
          deferredSettings.height,
          PREVIEW_OVERSCAN_FACTOR,
        ),
        center: deferredSettings.center,
        zoomHint: deferredSettings.zoomHint,
      })
      .then((features) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setSourceData(features);
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Unable to load the selected source.';
        startTransition(() => {
          setSourceData(null);
          setPreparedViewport(null);
          setCompiledViewport(null);
          setCuration(null);
          setPattern(null);
          setPreviewPattern(null);
          setSourceError(message);
          setPreviewMotion(null);
          setIsRefreshingPreview(false);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    deferredSettings.center,
    deferredSettings.height,
    deferredSettings.width,
    deferredSettings.zoomHint,
  ]);

  useEffect(() => {
    if (!sourceData) {
      return;
    }

    setIsRefreshingPreview(true);

    const currentViewportBBox = viewportBBox(
      deferredSettings.center,
      deferredSettings.zoomHint,
      deferredSettings.width,
      deferredSettings.height,
    );
    const previewViewportBBox = viewportBBox(
      deferredSettings.center,
      deferredSettings.zoomHint,
      deferredSettings.width,
      deferredSettings.height,
      PREVIEW_OVERSCAN_FACTOR,
    );
    const previewWidth = Math.max(
      deferredSettings.width + 8,
      Math.round(deferredSettings.width * PREVIEW_OVERSCAN_FACTOR),
    );
    const previewHeight = Math.max(
      deferredSettings.height + 8,
      Math.round(deferredSettings.height * PREVIEW_OVERSCAN_FACTOR),
    );
    const actualFeatures = filterFeaturesToBBox(sourceData.features, currentViewportBBox);
    const previewFeatures = filterFeaturesToBBox(sourceData.features, previewViewportBBox);

    const actual = {
      curation: curateFeatures(actualFeatures, {
        bbox: currentViewportBBox,
        width: deferredSettings.width,
        height: deferredSettings.height,
        detailLevel: deferredSettings.detailLevel,
        includeMinorRoads: true,
        roadNetworkDetail: deferredSettings.roadNetworkDetail,
      }),
      options: {
        title: `${sourceData.title} Pattern`,
        width: deferredSettings.width,
        height: deferredSettings.height,
        bbox: currentViewportBBox,
        includeMinorRoads: true,
      },
    };
    const preview = {
      curation: curateFeatures(previewFeatures, {
        bbox: previewViewportBBox,
        width: previewWidth,
        height: previewHeight,
        detailLevel: deferredSettings.detailLevel,
        includeMinorRoads: true,
        roadNetworkDetail: deferredSettings.roadNetworkDetail,
      }),
      options: {
        title: `${sourceData.title} Preview`,
        width: previewWidth,
        height: previewHeight,
        bbox: previewViewportBBox,
        includeMinorRoads: true,
      },
    };

    startTransition(() => {
      setCuration(actual.curation);
      setPreparedViewport({ actual, preview });
    });
  }, [
    deferredSettings.detailLevel,
    deferredSettings.height,
    deferredSettings.roadNetworkDetail,
    deferredSettings.width,
    sourceData,
  ]);

  useEffect(() => {
    if (!preparedViewport) {
      return;
    }

    const actualBaseCells = compilePatternCells(
      preparedViewport.actual.curation.features,
      preparedViewport.actual.options,
    );
    const actualBaseOverlays = compilePatternOverlays(
      preparedViewport.actual.curation.features,
      preparedViewport.actual.options,
    );
    const actualBasePattern = buildPatternDocument({
      title: preparedViewport.actual.options.title,
      width: preparedViewport.actual.options.width,
      height: preparedViewport.actual.options.height,
      bbox: preparedViewport.actual.options.bbox,
      cells: actualBaseCells,
      backstitches: actualBaseOverlays.backstitches,
      markers: actualBaseOverlays.markers,
    });
    const previewBaseCells = compilePatternCells(
      preparedViewport.preview.curation.features,
      preparedViewport.preview.options,
    );
    const previewBaseOverlays = compilePatternOverlays(
      preparedViewport.preview.curation.features,
      preparedViewport.preview.options,
    );
    const previewBasePattern = buildPatternDocument({
      title: preparedViewport.preview.options.title,
      width: preparedViewport.preview.options.width,
      height: preparedViewport.preview.options.height,
      bbox: preparedViewport.preview.options.bbox,
      cells: previewBaseCells,
      backstitches: previewBaseOverlays.backstitches,
      markers: previewBaseOverlays.markers,
    });

    startTransition(() => {
      setAvailableLegend(actualBasePattern.legend.filter(isInteractiveLegendEntry));
      setCompiledViewport({
        actual: {
          ...preparedViewport.actual,
          baseCells: actualBaseCells,
          baseOverlays: actualBaseOverlays,
          basePattern: actualBasePattern,
        },
        preview: {
          ...preparedViewport.preview,
          baseCells: previewBaseCells,
          baseOverlays: previewBaseOverlays,
          basePattern: previewBasePattern,
        },
        availableLegend: actualBasePattern.legend.filter(isInteractiveLegendEntry),
      });
    });
  }, [preparedViewport]);

  useEffect(() => {
    if (!compiledViewport) {
      return;
    }

    setIsRefreshingPreview(true);

    const nextPattern = buildVisiblePattern(compiledViewport.actual, hiddenLegendEntries);
    const nextPreviewPattern = buildVisiblePattern(compiledViewport.preview, hiddenLegendEntries);

    startTransition(() => {
      setPattern(nextPattern);
      setPreviewPattern(nextPreviewPattern);
    });
  }, [compiledViewport, hiddenLegendEntries]);

  useEffect(() => {
    if (!pattern || !previewPattern || !canvasRef.current) {
      return;
    }

    const cellSize = Math.max(7, Math.min(14, Math.floor(860 / pattern.width)));

    if (viewMode === 'chart') {
      drawChartPreview(canvasRef.current, previewPattern, cellSize);
    } else {
      drawStitchPreview(canvasRef.current, previewPattern, cellSize);
    }

    setIsRefreshingPreview(false);
    setPreviewMotion((current) => (current ? null : current));
  }, [pattern, previewPattern, viewMode]);

  useEffect(() => () => {
    searchAbortRef.current?.abort();
  }, []);

  function updateSettings<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function jumpToSearchResult(result: SearchResult) {
    setSettings((current) => ({
      ...current,
      center: {
        lat: result.lat,
        lon: result.lon,
      },
      zoomHint: searchBBoxToZoom(result.bbox, current.width, current.height, current.zoomHint),
    }));
    setPreviewMotion(null);
  }

  async function handleLocationSearch(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError('Type a place name, neighborhood, or address to search.');
      setSearchStatus('idle');
      return;
    }

    searchAbortRef.current?.abort();
    const abortController = new AbortController();
    searchAbortRef.current = abortController;

    setSearchStatus('loading');
    setSearchError(null);

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '5',
        addressdetails: '1',
      });
      const response = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
        signal: abortController.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Search failed with status ${response.status}.`);
      }

      const payload: unknown = await response.json();
      const results = Array.isArray(payload)
        ? payload.map(normalizeSearchResult).filter((result): result is SearchResult => Boolean(result))
        : [];

      setSearchResults(results);
      setSearchStatus('done');
      setSearchError(results.length ? null : `No matches found for "${query}".`);
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unable to search for that location right now.';
      setSearchResults([]);
      setSearchStatus('done');
      setSearchError(message);
    } finally {
      if (searchAbortRef.current === abortController) {
        searchAbortRef.current = null;
      }
    }
  }

  function applyPan(deltaX: number, deltaY: number) {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);

    setSettings((current) => ({
      ...current,
      center: (() => {
        const aspectRatio = Math.max(0.5, current.width / Math.max(1, current.height));
        const spanY = SLIPPY_VIEW_HEIGHT_TILES;
        const spanX = spanY * aspectRatio;
        const worldScale = 2 ** current.zoomHint;
        const currentWorld = lonLatToWorld(current.center.lon, current.center.lat, current.zoomHint);
        const nextX = Math.min(
          worldScale - 1e-6,
          Math.max(0, currentWorld.x - (deltaX / width) * spanX),
        );
        const nextY = Math.min(
          worldScale - 1e-6,
          Math.max(0, currentWorld.y - (deltaY / height) * spanY),
        );
        return worldToLonLat(nextX, nextY, current.zoomHint);
      })(),
    }));
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    dragRef.current = {
      pointerId: event.pointerId,
      startMotion: previewMotion,
      startX: event.clientX,
      startY: event.clientY,
    };
    setIsDraggingPreview(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const startMotion = dragRef.current.startMotion ?? {
      scale: 1,
      translateX: 0,
      translateY: 0,
    };

    setPreviewMotion({
      scale: startMotion.scale,
      translateX: startMotion.translateX + (event.clientX - dragRef.current.startX),
      translateY: startMotion.translateY + (event.clientY - dragRef.current.startY),
    });
  }

  function finishCanvasDrag(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const startMotion = dragRef.current.startMotion ?? {
      scale: 1,
      translateX: 0,
      translateY: 0,
    };
    const deltaX = event.clientX - dragRef.current.startX;
    const deltaY = event.clientY - dragRef.current.startY;
    dragRef.current = null;
    setIsDraggingPreview(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      setPreviewMotion({
        scale: startMotion.scale,
        translateX: startMotion.translateX + deltaX,
        translateY: startMotion.translateY + deltaY,
      });
      applyPan(deltaX, deltaY);
      return;
    }

    setPreviewMotion(startMotion.scale === 1 && startMotion.translateX === 0 && startMotion.translateY === 0
      ? null
      : startMotion);
  }

  function handlePreviewWheel(event: ReactWheelEvent<HTMLElement>) {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    event.preventDefault();

    const rect = viewport.getBoundingClientRect();
    applyPreviewZoom(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1 : -1);
  }

  function applyPreviewZoom(anchorX: number, anchorY: number, zoomDelta: number) {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const normalizedX = anchorX / Math.max(1, rect.width);
    const normalizedY = anchorY / Math.max(1, rect.height);
    const nextZoom = clampZoom(settings.zoomHint + zoomDelta);
    if (nextZoom === settings.zoomHint) {
      return;
    }

    setSettings((current) => ({
      ...current,
      ...(() => {
        const nextZoom = clampZoom(current.zoomHint + zoomDelta);
        if (nextZoom === current.zoomHint) {
          return { zoomHint: current.zoomHint, center: current.center };
        }

        const aspectRatio = Math.max(0.5, current.width / Math.max(1, current.height));
        const oldSpanY = SLIPPY_VIEW_HEIGHT_TILES;
        const oldSpanX = oldSpanY * aspectRatio;
        const currentWorld = lonLatToWorld(current.center.lon, current.center.lat, current.zoomHint);
        const worldX = currentWorld.x + (normalizedX - 0.5) * oldSpanX;
        const worldY = currentWorld.y + (normalizedY - 0.5) * oldSpanY;
        const focus = worldToLonLat(worldX, worldY, current.zoomHint);
        const focusAtNextZoom = lonLatToWorld(focus.lon, focus.lat, nextZoom);
        const nextSpanY = SLIPPY_VIEW_HEIGHT_TILES;
        const nextSpanX = nextSpanY * aspectRatio;
        const nextCenter = worldToLonLat(
          focusAtNextZoom.x - (normalizedX - 0.5) * nextSpanX,
          focusAtNextZoom.y - (normalizedY - 0.5) * nextSpanY,
          nextZoom,
        );

        return {
          zoomHint: nextZoom,
          center: nextCenter,
        };
      })(),
    }));

    const zoomFactor = 2 ** zoomDelta;
    setPreviewMotion((currentPreviewMotion) => {
      const currentMotion = currentPreviewMotion ?? {
        scale: 1,
        translateX: 0,
        translateY: 0,
      };

      return {
        scale: currentMotion.scale * zoomFactor,
        translateX:
          (1 - zoomFactor) * (anchorX - previewBaseOffsetX) + zoomFactor * currentMotion.translateX,
        translateY:
          (1 - zoomFactor) * (anchorY - previewBaseOffsetY) + zoomFactor * currentMotion.translateY,
      };
    });
  }

  function handleCanvasDoubleClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    applyPreviewZoom(event.clientX - rect.left, event.clientY - rect.top, 1);
  }

  function handlePngExport() {
    if (!canvasRef.current || !pattern) {
      return;
    }

    exportCanvasPng(canvasRef.current, `${pattern.title.toLowerCase().replace(/\s+/g, '-')}-${viewMode}.png`);
  }

  function toggleLegendEntry(entry: LegendEntry) {
    const key = legendEntryKey(entry);
    setHiddenLegendEntries((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const legend = availableLegend;
  const diagnostics = sourceData?.diagnostics;
  const sourceFeatureCount = sourceData?.features.length ?? 0;
  const curationStats = curation?.stats;
  const curatedFeatureCount = curationStats?.curatedCount ?? 0;
  const droppedFeatureCount = curationStats
    ? curationStats.originalCount - curationStats.curatedCount
    : 0;
  const diagnosticsSummary = diagnostics
    ? `${diagnostics.fetchedTileCount}/${diagnostics.tileCount} tiles · ${sourceFeatureCount.toLocaleString()} normalized features · ${curatedFeatureCount.toLocaleString()} kept`
    : null;
  const orderedLegend = [
    ...legend.filter((entry) => entry.mode === 'fill'),
    ...legend.filter((entry) => entry.mode === 'line'),
    ...legend.filter((entry) => entry.mode === 'marker'),
  ];

  const cellSize = Math.max(7, Math.min(14, Math.floor(860 / Math.max(1, settings.width))));
  const previewViewportStyle =
    pattern && previewPattern
      ? {
          width: pattern.width * cellSize + PREVIEW_PADDING * 2,
          height: pattern.height * cellSize + PREVIEW_PADDING * 2,
        }
      : undefined;
  const previewBaseOffsetX =
    pattern && previewPattern ? -((previewPattern.width - pattern.width) * cellSize) / 2 : 0;
  const previewBaseOffsetY =
    pattern && previewPattern ? -((previewPattern.height - pattern.height) * cellSize) / 2 : 0;
  const previewCanvasStyle =
    pattern && previewPattern
      ? {
          transform: `translate(${previewBaseOffsetX + (previewMotion?.translateX ?? 0)}px, ${
            previewBaseOffsetY + (previewMotion?.translateY ?? 0)
          }px) scale(${previewMotion?.scale ?? 1})`,
          transformOrigin: '0 0',
        }
      : undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="eyebrow">Map-to-stitch compiler</p>
          <h1>OpenStitchMap</h1>
          <p>
            Turn OSM-style features into a printable cross stitch chart with
            roads as backstitch and landmarks as symbols.
          </p>
        </div>

        <section className="sidebar-section">
          <div className="control-group">
            <div className="dimension-row">
              <div className="control-row">
                <label htmlFor="width">Pattern width</label>
                <input
                  className="number-input"
                  id="width"
                  type="number"
                  min={36}
                  max={180}
                  value={settings.width}
                  onChange={(event) =>
                    updateSettings('width', clampDimension(Number(event.target.value), settings.width))
                  }
                />
              </div>

              <div className="control-row">
                <label htmlFor="height">Pattern height</label>
                <input
                  className="number-input"
                  id="height"
                  type="number"
                  min={36}
                  max={180}
                  value={settings.height}
                  onChange={(event) =>
                    updateSettings('height', clampDimension(Number(event.target.value), settings.height))
                  }
                />
              </div>
            </div>

            <div>
              <div className="stats-title">Stitched size</div>
              <div className="stats-grid">
                <div className="stat-tile">
                  <div className="stat-value">{inches(settings.width, settings.fabricCount)} in</div>
                  <div className="stat-label">Width on {settings.fabricCount}-count fabric</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-value">{inches(settings.height, settings.fabricCount)} in</div>
                  <div className="stat-label">Height on {settings.fabricCount}-count fabric</div>
                </div>
              </div>
            </div>

            <fieldset className="control-row radio-fieldset">
              <legend>Fabric count</legend>
              <div className="radio-group">
                {FABRIC_COUNTS.map((count) => (
                  <label className="radio-option" key={count}>
                    <input
                      type="radio"
                      name="fabric-count"
                      value={count}
                      checked={settings.fabricCount === count}
                      onChange={() => updateSettings('fabricCount', count)}
                    />
                    <span>{count} count</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="control-group">
            <div className="control-row">
              <div className="legend-title">Stitch detail</div>
              <div className="segmented three-up" role="tablist" aria-label="Stitch detail">
                {(['low', 'medium', 'high'] as const).map((level) => (
                  <button
                    key={level}
                    className={`segment ${settings.detailLevel === level ? 'active' : ''}`}
                    type="button"
                    onClick={() => updateSettings('detailLevel', level)}
                  >
                    {level[0].toUpperCase()}
                    {level.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="control-row">
              <div className="control-label-row">
                <label htmlFor="road-network-detail">Road detail</label>
                <span>{roadNetworkDetailLabel(settings.roadNetworkDetail)}</span>
              </div>
              <input
                className="range-input"
                id="road-network-detail"
                type="range"
                min={0}
                max={100}
                value={settings.roadNetworkDetail}
                aria-valuetext={roadNetworkDetailLabel(settings.roadNetworkDetail)}
                onInput={(event) =>
                  updateSettings('roadNetworkDetail', clampRoadNetworkDetail(Number(event.currentTarget.value)))
                }
                onChange={(event) =>
                  updateSettings('roadNetworkDetail', clampRoadNetworkDetail(Number(event.target.value)))
                }
              />
            </div>

            <div className="control-row">
              <div className="legend-title">Preview mode</div>
              <div className="segmented" role="tablist" aria-label="Preview mode">
                <button
                  className={`segment ${viewMode === 'chart' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setViewMode('chart')}
                >
                  Chart
                </button>
                <button
                  className={`segment ${viewMode === 'stitched' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setViewMode('stitched')}
                >
                  Stitched
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="actions">
            <button className="button primary" type="button" onClick={handlePngExport}>
              Export PNG
            </button>
          </div>

          <p className="sidebar-attribution">
            <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
              OpenFreeMap
            </a>{' '}
            <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">
              &copy; OpenMapTiles
            </a>{' '}
            Data from{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>
          </p>
        </section>
      </aside>

      <main className="workspace">
        <div className="workspace-header">
          <p>
            Scroll or double-click to zoom and drag the preview to pan. Use the grouped
            legend below to hide individual areas, ways, or POIs from the stitched map.
          </p>

          <form className="location-search workspace-search" onSubmit={handleLocationSearch}>
            <div className="search-row">
              <input
                className="input"
                id="location-search"
                type="search"
                placeholder="Search for a place or address"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <button className="button" type="submit" disabled={searchStatus === 'loading'}>
                {searchStatus === 'loading' ? 'Searching...' : 'Search'}
              </button>
            </div>

            {searchError ? <div className="search-feedback">{searchError}</div> : null}

            {searchResults.length ? (
              <div className="search-results" role="list" aria-label="Search results">
                {searchResults.map((result) => (
                  <button
                    className="search-result"
                    key={result.id}
                    type="button"
                    onClick={() => jumpToSearchResult(result)}
                  >
                    <strong>{result.label}</strong>
                    <span>{result.detail}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </form>
        </div>

        <section
          className="preview-frame interactive"
          aria-label="Pattern preview"
          onWheel={handlePreviewWheel}
        >
          <div className="preview-center">
            {sourceError ? (
              <div className="empty-state">
                <strong>Source load failed.</strong>
                <div>{sourceError}</div>
              </div>
            ) : pattern ? (
              <div
                className="preview-viewport"
                ref={previewViewportRef}
                style={previewViewportStyle}
              >
                <canvas
                  className={`preview-canvas ${
                    isDraggingPreview ? 'dragging' : 'draggable'
                  } ${isRefreshingPreview ? 'updating' : ''}`}
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={finishCanvasDrag}
                  onPointerCancel={finishCanvasDrag}
                  onDoubleClick={handleCanvasDoubleClick}
                  style={previewCanvasStyle}
                />
              </div>
            ) : (
              <div className="empty-state">Preparing the first chart preview.</div>
            )}
          </div>
        </section>

        <section className="legend-section">
          <div className="legend-title">Legend</div>
          <div className="legend-band">
            {orderedLegend.map((entry) => (
              <button
                className={`legend-item ${hiddenLegendEntries.has(legendEntryKey(entry)) ? 'inactive' : 'active'}`}
                key={legendEntryKey(entry)}
                type="button"
                aria-pressed={!hiddenLegendEntries.has(legendEntryKey(entry))}
                onClick={() => toggleLegendEntry(entry)}
              >
                <div
                  className={`legend-swatch ${entry.mode}`}
                  style={entry.mode === 'fill' ? { backgroundColor: entry.color } : { color: entry.color }}
                  aria-hidden="true"
                >
                  <span className={`legend-symbol legend-symbol-${entry.mode}`} />
                </div>
                <div className="legend-meta">
                  <strong>{entry.label}</strong>
                  <span>{entry.floss}</span>
                </div>
                <div className="legend-usage">
                  <strong>{entry.usage}</strong>
                  {hiddenLegendEntries.has(legendEntryKey(entry)) ? <span>Hidden</span> : null}
                </div>
              </button>
            ))}
          </div>
        </section>

        {diagnostics && diagnosticsSummary ? (
          <details className="diagnostics-panel">
            <summary className="diagnostics-summary">
              <span className="legend-title">Source diagnostics</span>
              <span>{diagnosticsSummary}</span>
            </summary>

            <div className="stats-grid diagnostics-grid">
              <div className="stat-tile">
                <div className="stat-value">{sourceFeatureCount}</div>
                <div className="stat-label">Normalized map features</div>
              </div>
              <div className="stat-tile">
                <div className="stat-value">{diagnostics.fetchedTileCount}/{diagnostics.tileCount}</div>
                <div className="stat-label">Fetched tiles</div>
              </div>
              <div className="stat-tile">
                <div className="stat-value">{diagnostics.totalDecodedFeatures}</div>
                <div className="stat-label">Decoded raw features</div>
              </div>
              <div className="stat-tile">
                <div className="stat-value">{diagnostics.layerStats.length}</div>
                <div className="stat-label">Layers seen in fetched tiles</div>
              </div>
            </div>

            {curationStats ? (
              <>
                <div className="legend-title">Stitch curation</div>
                <div className="stats-grid diagnostics-grid">
                  <div className="stat-tile">
                    <div className="stat-value">{curatedFeatureCount}</div>
                    <div className="stat-label">Features kept for the pattern</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{droppedFeatureCount}</div>
                    <div className="stat-label">Dropped before compilation</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">
                      {curationStats.polygonsKept}/{curationStats.linesKept}/{curationStats.markersKept}
                    </div>
                    <div className="stat-label">Polygons, lines, markers kept</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">
                      {curationStats.droppedSmallPolygons +
                        curationStats.droppedShortLines +
                        curationStats.droppedOverlappingLines +
                        curationStats.droppedAdjacentPaths +
                        curationStats.droppedRoadBudget}
                    </div>
                    <div className="stat-label">Tiny fills and skipped ways removed</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{curationStats.roadsCollapsed}</div>
                    <div className="stat-label">Parallel way candidates collapsed</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{curationStats.droppedRoadBudget}</div>
                    <div className="stat-label">Road candidates outside detail budget</div>
                  </div>
                </div>
              </>
            ) : null}

            <div className="layer-band">
              {diagnostics.layerStats.slice(0, 8).map((layer) => (
                <div className="layer-item" key={layer.layerName}>
                  <strong>{layer.layerName}</strong>
                  <span>{layer.features} features</span>
                  <span>{layer.polygons} polygons, {layer.lines} lines, {layer.points} points</span>
                  <span>{layer.sampleKeys.join(', ') || 'No sampled properties'}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </main>
    </div>
  );
}
