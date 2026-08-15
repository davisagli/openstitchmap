import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import type {
  FormEvent as ReactFormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import "./App.css";
import type { BBox, MapFeature, Position } from "../core/osm";
import type { LoadedSourceData } from "../core/tiles/tileSource";
import { HostedVectorTileSource } from "../core/tiles/hostedVectorSource";
import { lonLatToWorld, worldToLonLat } from "../core/tiles/mercator";
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
} from "../core/pattern/compilePattern";
import {
  curateFeatures,
  type CurateFeaturesResult,
  type DetailLevel,
} from "../core/pattern/curateFeatures";
import { drawChartPreview } from "../render/drawChartPreview";
import { drawStitchPreview } from "../render/drawStitchPreview";
import { exportCanvasPng } from "../render/exporters";
import { updateFaviconFromCanvas } from "../render/updateFavicon";

type ViewMode = "chart" | "stitched";
type FabricCount = 14 | 16 | 18;

interface PreviewMotion {
  scale: number;
  translateX: number;
  translateY: number;
}

interface WheelZoomFeedback {
  baseMotion: PreviewMotion | null;
  direction: 1 | -1;
}

interface PreviewPointer {
  x: number;
  y: number;
}

interface PinchGesture {
  pointerIds: [number, number];
  baseMotion: PreviewMotion | null;
  anchorX: number;
  anchorY: number;
  startDistance: number;
  scale: number;
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
}

interface PreparedPatternVariant {
  curation: CurateFeaturesResult;
  options: CompilePatternOptions;
}

interface PreparedViewportData {
  actual: PreparedPatternVariant;
  renderRequestKey: string;
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
  renderRequestKey: string;
}

interface SearchResult {
  id: string;
  label: string;
  detail: string;
  lat: number;
  lon: number;
  bbox: BBox | null;
}

const HOSTED_TILEJSON_URL = "https://tiles.openfreemap.org/planet";
const DEFAULT_MAP_CENTER = { lon: -122.3428, lat: 47.6076 };
const SLIPPY_VIEW_HEIGHT_TILES = 1;
// Keep a full viewport of rendered map outside every edge so a complete pan
// gesture stays covered while the newly centered preview is being prepared.
const PREVIEW_OVERSCAN_FACTOR = 3;
const PREVIEW_CANVAS_PADDING = 24;
const FABRIC_COUNTS: FabricCount[] = [14, 16, 18];
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const HOSTED_SOURCE_MAX_ZOOM = 14;
const ROAD_SOURCE_ZOOM_OFFSETS = [2, 1, 0] as const;
const WHEEL_ZOOM_THRESHOLD = 180;
const WHEEL_ZOOM_IDLE_COMMIT_THRESHOLD = 48;
const WHEEL_ZOOM_FEEDBACK_MAX_SCALE = 0.16;
const DEFAULT_MAP_ZOOM = 11;
const MIN_MAP_ZOOM = 0;
const MAX_MAP_ZOOM = 16;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const TILE_ATTRIBUTION =
  "OpenFreeMap · © OpenMapTiles · Data © OpenStreetMap contributors";

function tileSourceRequestKey(settings: Settings): string {
  return JSON.stringify([
    settings.center.lon,
    settings.center.lat,
    settings.width,
    settings.height,
    settings.zoomHint,
    settings.roadNetworkDetail,
  ]);
}

function previewRenderRequestKey(settings: Settings): string {
  return `${tileSourceRequestKey(settings)}:${settings.detailLevel}`;
}

const defaultSettings: Settings = {
  center: DEFAULT_MAP_CENTER,
  width: 96,
  height: 72,
  fabricCount: 14,
  detailLevel: "high",
  roadNetworkDetail: 1,
  zoomHint: DEFAULT_MAP_ZOOM,
};

interface UrlState {
  settings: Settings;
  viewMode: ViewMode;
  hiddenLegendEntries: Set<string>;
}

function clampDimension(value: number, fallback: number): number {
  if (Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(180, Math.max(36, Math.round(value)));
}

function numberParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const rawValue = params.get(name);
  if (rawValue === null || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : fallback;
}

function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const fabricCount = numberParam(
    params,
    "fabric",
    defaultSettings.fabricCount,
  );
  const detailLevel = params.get("detail");
  const viewMode = params.get("view");

  return {
    settings: {
      center: {
        lat: Math.min(
          MAX_MERCATOR_LATITUDE,
          Math.max(
            -MAX_MERCATOR_LATITUDE,
            numberParam(params, "lat", defaultSettings.center.lat),
          ),
        ),
        lon: Math.min(
          180,
          Math.max(
            -180,
            numberParam(params, "lon", defaultSettings.center.lon),
          ),
        ),
      },
      width: clampDimension(
        numberParam(params, "width", defaultSettings.width),
        defaultSettings.width,
      ),
      height: clampDimension(
        numberParam(params, "height", defaultSettings.height),
        defaultSettings.height,
      ),
      fabricCount: FABRIC_COUNTS.includes(fabricCount as FabricCount)
        ? (fabricCount as FabricCount)
        : defaultSettings.fabricCount,
      detailLevel:
        detailLevel === "low" ||
        detailLevel === "medium" ||
        detailLevel === "high"
          ? detailLevel
          : defaultSettings.detailLevel,
      roadNetworkDetail: clampRoadNetworkDetail(
        numberParam(
          params,
          "roadDetail",
          defaultSettings.roadNetworkDetail,
        ),
      ),
      zoomHint: clampZoom(
        numberParam(params, "zoom", defaultSettings.zoomHint),
      ),
    },
    viewMode:
      viewMode === "chart" || viewMode === "stitched" ? viewMode : "chart",
    hiddenLegendEntries: new Set(
      params.getAll("hidden").filter((key) => key.trim().length > 0),
    ),
  };
}

function writeUrlState({
  settings,
  viewMode,
  hiddenLegendEntries,
}: UrlState) {
  const url = new URL(window.location.href);
  url.searchParams.set("lat", settings.center.lat.toFixed(6));
  url.searchParams.set("lon", settings.center.lon.toFixed(6));
  url.searchParams.set("zoom", String(settings.zoomHint));
  url.searchParams.set("width", String(settings.width));
  url.searchParams.set("height", String(settings.height));
  url.searchParams.set("fabric", String(settings.fabricCount));
  url.searchParams.set("detail", settings.detailLevel);
  url.searchParams.set("roadDetail", String(settings.roadNetworkDetail));
  url.searchParams.set("view", viewMode);
  url.searchParams.delete("hidden");
  Array.from(hiddenLegendEntries)
    .sort()
    .forEach((key) => url.searchParams.append("hidden", key));
  window.history.replaceState(window.history.state, "", url);
}

function inches(stitches: number, fabricCount: number): string {
  return (stitches / fabricCount).toFixed(1);
}

function centimeters(stitches: number, fabricCount: number): string {
  return ((stitches / fabricCount) * 2.54).toFixed(1);
}

function stitchedSizeLabel(stitches: number, fabricCount: number): string {
  return `${inches(stitches, fabricCount)} in / ${centimeters(stitches, fabricCount)} cm`;
}

function formatLegendUsage(usage: number): string {
  return Math.round(usage).toLocaleString();
}

function previewStitchInset(
  previewStitches: number,
  patternStitches: number,
): number {
  return Math.max(0, Math.round((previewStitches - patternStitches) / 2));
}

function snappedPreviewOffset(
  previewStitches: number,
  patternStitches: number,
  cellSize: number,
): number {
  return (
    -PREVIEW_CANVAS_PADDING -
    previewStitchInset(previewStitches, patternStitches) * cellSize
  );
}

function defaultPreviewMotion(): PreviewMotion {
  return {
    scale: 1,
    translateX: 0,
    translateY: 0,
  };
}

function zoomPreviewMotion(
  baseMotion: PreviewMotion | null,
  anchorX: number,
  anchorY: number,
  baseOffsetX: number,
  baseOffsetY: number,
  zoomFactor: number,
): PreviewMotion {
  const motion = baseMotion ?? defaultPreviewMotion();
  return {
    scale: motion.scale * zoomFactor,
    translateX:
      (1 - zoomFactor) * (anchorX - baseOffsetX) +
      zoomFactor * motion.translateX,
    translateY:
      (1 - zoomFactor) * (anchorY - baseOffsetY) +
      zoomFactor * motion.translateY,
  };
}

function pointerDistance(first: PreviewPointer, second: PreviewPointer) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointerMidpoint(
  first: PreviewPointer,
  second: PreviewPointer,
): PreviewPointer {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function clampZoom(value: number): number {
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, Math.round(value)));
}

function clampRoadNetworkDetail(value: number): number {
  if (Number.isNaN(value)) {
    return defaultSettings.roadNetworkDetail;
  }

  return Math.min(
    ROAD_SOURCE_ZOOM_OFFSETS.length - 1,
    Math.max(0, Math.round(value)),
  );
}

function roadSourceZoomOffset(detail: number): number {
  return ROAD_SOURCE_ZOOM_OFFSETS[clampRoadNetworkDetail(detail)];
}

function roadNetworkDetailLabel(value: number): string {
  switch (clampRoadNetworkDetail(value)) {
    case 0:
      return "Low";
    case 1:
      return "Medium";
    default:
      return "High";
  }
}

function roadSourceZoom(baseZoom: number, detail: number): number {
  const effectiveBaseZoom = Math.min(HOSTED_SOURCE_MAX_ZOOM, baseZoom);
  return Math.max(0, effectiveBaseZoom - roadSourceZoomOffset(detail));
}

function viewportSpanX(width: number, height: number): number {
  return SLIPPY_VIEW_HEIGHT_TILES * Math.max(0.5, width / Math.max(1, height));
}

function viewportBBox(
  center: { lat: number; lon: number },
  zoom: number,
  width: number,
  height: number,
): BBox {
  const aspectRatio = Math.max(0.5, width / Math.max(1, height));
  const world = lonLatToWorld(center.lon, center.lat, zoom);
  const worldScale = 2 ** zoom;
  const spanY = SLIPPY_VIEW_HEIGHT_TILES;
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

function expandedPreviewBBox(viewport: BBox, factor: number): BBox {
  const longitudePadding =
    ((viewport.maxLon - viewport.minLon) * (factor - 1)) / 2;
  const latitudePadding =
    ((viewport.maxLat - viewport.minLat) * (factor - 1)) / 2;

  return {
    minLon: viewport.minLon - longitudePadding,
    minLat: viewport.minLat - latitudePadding,
    maxLon: viewport.maxLon + longitudePadding,
    maxLat: viewport.maxLat + latitudePadding,
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
  if (feature.type === "point") {
    const [lon, lat] = feature.coordinates;
    return { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat };
  }

  if (feature.type === "line") {
    return positionsBBox(feature.coordinates);
  }

  return positionsBBox(feature.coordinates.flat());
}

function filterFeaturesToBBox(
  features: MapFeature[],
  bbox: BBox,
): MapFeature[] {
  return features.filter((feature) =>
    bboxIntersects(featureBBox(feature), bbox),
  );
}

function legendEntryKey(entry: Pick<LegendEntry, "id" | "mode">): string {
  return `${entry.mode}:${entry.id}`;
}

function isInteractiveLegendEntry(entry: LegendEntry): boolean {
  return !(entry.mode === "fill" && entry.id === "ground");
}

function featureLegendKey(feature: MapFeature): string | null {
  if (feature.type === "polygon") {
    const style = classifyPolygon(feature);
    return style ? `fill:${style.id}` : null;
  }

  if (feature.type === "line") {
    const kind = classifyLine(feature);
    return kind ? `line:${kind}` : null;
  }

  const kind = classifyMarker(feature);
  return kind ? `marker:${kind}` : null;
}

function filterFeaturesByLegendSelection(
  features: MapFeature[],
  hiddenEntries: Set<string>,
): MapFeature[] {
  if (!hiddenEntries.size) {
    return features;
  }

  return features.filter((feature) => {
    const key = featureLegendKey(feature);
    return key ? !hiddenEntries.has(key) : true;
  });
}

function hasHiddenLegendMode(
  hiddenEntries: Set<string>,
  mode: LegendEntry["mode"],
): boolean {
  for (const key of hiddenEntries) {
    if (key.startsWith(`${mode}:`)) {
      return true;
    }
  }

  return false;
}

function filterBackstitchesByLegendSelection(
  backstitches: PatternOverlayData["backstitches"],
  hiddenEntries: Set<string>,
) {
  if (!hasHiddenLegendMode(hiddenEntries, "line")) {
    return backstitches;
  }

  return backstitches.filter(
    (segment) => !hiddenEntries.has(`line:${segment.kind}`),
  );
}

function filterMarkersByLegendSelection(
  markers: PatternOverlayData["markers"],
  hiddenEntries: Set<string>,
) {
  if (!hasHiddenLegendMode(hiddenEntries, "marker")) {
    return markers;
  }

  return markers.filter(
    (marker) => !hiddenEntries.has(`marker:${marker.kind}`),
  );
}

function compilePreparedPattern(
  variant: PreparedPatternVariant,
): CompiledPatternVariant {
  const baseCells = compilePatternCells(
    variant.curation.features,
    variant.options,
  );
  const baseOverlays = compilePatternOverlays(
    variant.curation.features,
    variant.options,
  );
  const basePattern = buildPatternDocument({
    title: variant.options.title,
    width: variant.options.width,
    height: variant.options.height,
    bbox: variant.options.bbox,
    cells: baseCells,
    backstitches: baseOverlays.backstitches,
    markers: baseOverlays.markers,
  });

  return {
    ...variant,
    baseCells,
    baseOverlays,
    basePattern,
  };
}

function buildVisiblePattern(
  variant: CompiledPatternVariant,
  hiddenEntries: Set<string>,
): PatternDocument {
  if (!hiddenEntries.size) {
    return variant.basePattern;
  }

  const backstitches = filterBackstitchesByLegendSelection(
    variant.baseOverlays.backstitches,
    hiddenEntries,
  );
  const markers = filterMarkersByLegendSelection(
    variant.baseOverlays.markers,
    hiddenEntries,
  );
  const cells = hasHiddenLegendMode(hiddenEntries, "fill")
    ? compilePatternCells(
        filterFeaturesByLegendSelection(
          variant.curation.features,
          hiddenEntries,
        ),
        variant.options,
      )
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
  return parts.filter((part) => part && part.trim().length > 0).join(", ");
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
  if (!value || typeof value !== "object") {
    return null;
  }

  const result = value as Record<string, unknown>;
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return null;
  }

  const displayName =
    typeof result.display_name === "string"
      ? result.display_name
      : "Unnamed place";
  const name =
    typeof result.name === "string" && result.name.trim().length > 0
      ? result.name
      : displayName.split(",")[0]?.trim() || displayName;
  const address =
    typeof result.address === "object" && result.address
      ? (result.address as Record<string, unknown>)
      : null;
  const detail = formatSearchDetail([
    typeof result.type === "string" ? result.type : null,
    address
      ? formatSearchDetail([
          typeof address.city === "string"
            ? address.city
            : typeof address.town === "string"
              ? address.town
              : typeof address.village === "string"
                ? address.village
                : null,
          typeof address.state === "string" ? address.state : null,
          typeof address.country === "string" ? address.country : null,
        ])
      : displayName.split(",").slice(1).join(",").trim(),
  ]);

  return {
    id:
      typeof result.place_id === "number" || typeof result.place_id === "string"
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
  const [initialUrlState] = useState(() =>
    readUrlState(window.location.search),
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewFrameRef = useRef<HTMLElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const searchFormRef = useRef<HTMLFormElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startMotion: PreviewMotion | null;
    startX: number;
    startY: number;
  } | null>(null);
  const activePreviewPointersRef = useRef(new Map<number, PreviewPointer>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const wheelZoomDeltaRef = useRef(0);
  const wheelZoomFeedbackRef = useRef<WheelZoomFeedback | null>(null);
  const wheelZoomFeedbackResetRef = useRef<number | null>(null);
  const loadedTileRequestKeyRef = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(initialUrlState.viewMode);
  const [isDraggingPreview, setIsDraggingPreview] = useState(false);
  const [previewMotion, setPreviewMotion] = useState<PreviewMotion | null>(
    null,
  );
  const [settings, setSettings] = useState<Settings>(
    initialUrlState.settings,
  );
  const deferredSettings = useDeferredValue(settings);
  const [sourceData, setSourceData] = useState<LoadedSourceData | null>(null);
  const [preparedViewport, setPreparedViewport] =
    useState<PreparedViewportData | null>(null);
  const [compiledViewport, setCompiledViewport] =
    useState<CompiledViewportData | null>(null);
  const [curation, setCuration] = useState<CurateFeaturesResult | null>(null);
  const [availableLegend, setAvailableLegend] = useState<LegendEntry[]>([]);
  const [hiddenLegendEntries, setHiddenLegendEntries] = useState<Set<string>>(
    initialUrlState.hiddenLegendEntries,
  );
  const [pattern, setPattern] = useState<PatternDocument | null>(null);
  const [previewPattern, setPreviewPattern] = useState<PatternDocument | null>(
    null,
  );
  const [renderedForegroundKey, setRenderedForegroundKey] = useState<
    string | null
  >(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isRefreshingPreview, setIsRefreshingPreview] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "done">(
    "idle",
  );
  const [locationStatus, setLocationStatus] = useState<"idle" | "loading">(
    "idle",
  );

  useEffect(() => {
    function restoreUrlState() {
      const urlState = readUrlState(window.location.search);
      setSettings(urlState.settings);
      setViewMode(urlState.viewMode);
      setHiddenLegendEntries(urlState.hiddenLegendEntries);
      setPreviewMotion(null);
      setSearchResults([]);
      setSearchError(null);
      setSearchStatus("idle");
    }

    window.addEventListener("popstate", restoreUrlState);
    return () => window.removeEventListener("popstate", restoreUrlState);
  }, []);

  useEffect(() => {
    writeUrlState({ settings, viewMode, hiddenLegendEntries });
  }, [hiddenLegendEntries, settings, viewMode]);

  useEffect(() => {
    let cancelled = false;
    const requestKey = tileSourceRequestKey(deferredSettings);
    const source = new HostedVectorTileSource(
      HOSTED_TILEJSON_URL,
      "OpenFreeMap",
    );
    const roadZoomHint = roadSourceZoom(
      deferredSettings.zoomHint,
      deferredSettings.roadNetworkDetail,
    );

    setSourceError(null);
    setIsRefreshingPreview(true);
    loadedTileRequestKeyRef.current = null;

    source
      .load({
        bbox: viewportBBox(
          deferredSettings.center,
          deferredSettings.zoomHint,
          deferredSettings.width,
          deferredSettings.height,
        ),
        center: deferredSettings.center,
        zoomHint: deferredSettings.zoomHint,
        roadZoomHint,
      })
      .then((features) => {
        if (cancelled) {
          return;
        }

        loadedTileRequestKeyRef.current = requestKey;
        startTransition(() => {
          setSourceData(features);
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "Unable to load the selected source.";
        loadedTileRequestKeyRef.current = null;
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
    deferredSettings.roadNetworkDetail,
    deferredSettings.width,
    deferredSettings.zoomHint,
  ]);

  useEffect(() => {
    const tileRequestKey = tileSourceRequestKey(deferredSettings);
    if (
      !sourceData ||
      loadedTileRequestKeyRef.current !== tileRequestKey
    ) {
      return;
    }

    setIsRefreshingPreview(true);

    const currentViewportBBox = viewportBBox(
      deferredSettings.center,
      deferredSettings.zoomHint,
      deferredSettings.width,
      deferredSettings.height,
    );
    const actualFeatures = filterFeaturesToBBox(
      sourceData.features,
      currentViewportBBox,
    );

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

    startTransition(() => {
      setCuration(actual.curation);
      setPreparedViewport({
        actual,
        renderRequestKey: previewRenderRequestKey(deferredSettings),
      });
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

    const compiledActual = compilePreparedPattern(preparedViewport.actual);
    const nextAvailableLegend = compiledActual.basePattern.legend.filter(
      isInteractiveLegendEntry,
    );

    startTransition(() => {
      setAvailableLegend(nextAvailableLegend);
      setCompiledViewport({
        actual: compiledActual,
        preview: compiledActual,
        availableLegend: nextAvailableLegend,
        renderRequestKey: preparedViewport.renderRequestKey,
      });
    });
  }, [preparedViewport]);

  useEffect(() => {
    if (!compiledViewport) {
      return;
    }

    setIsRefreshingPreview(true);

    const nextPattern = buildVisiblePattern(
      compiledViewport.actual,
      hiddenLegendEntries,
    );
    const nextPreviewPattern = buildVisiblePattern(
      compiledViewport.preview,
      hiddenLegendEntries,
    );

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

    if (viewMode === "chart") {
      drawChartPreview(canvasRef.current, previewPattern, cellSize, {
        x: previewStitchInset(previewPattern.width, pattern.width) % 10,
        y: previewStitchInset(previewPattern.height, pattern.height) % 10,
      });
    } else {
      drawStitchPreview(canvasRef.current, previewPattern, cellSize);
    }

    updateFaviconFromCanvas(canvasRef.current, {
      width: pattern.width * cellSize,
      height: pattern.height * cellSize,
      canvasOffsetX: snappedPreviewOffset(
        previewPattern.width,
        pattern.width,
        cellSize,
      ),
      canvasOffsetY: snappedPreviewOffset(
        previewPattern.height,
        pattern.height,
        cellSize,
      ),
    });

    setIsRefreshingPreview(false);
    setPreviewMotion((current) => (current ? null : current));
    if (
      previewPattern.width === pattern.width &&
      previewPattern.height === pattern.height
    ) {
      setRenderedForegroundKey(compiledViewport?.renderRequestKey ?? null);
    }
  }, [pattern, previewPattern, viewMode]);

  useEffect(() => {
    const tileRequestKey = tileSourceRequestKey(deferredSettings);
    const renderRequestKey = previewRenderRequestKey(deferredSettings);
    if (
      !sourceData ||
      loadedTileRequestKeyRef.current !== tileRequestKey ||
      renderedForegroundKey !== renderRequestKey
    ) {
      return;
    }

    let cancelled = false;
    const source = new HostedVectorTileSource(
      HOSTED_TILEJSON_URL,
      "OpenFreeMap",
    );
    const roadZoomHint = roadSourceZoom(
      deferredSettings.zoomHint,
      deferredSettings.roadNetworkDetail,
    );
    const currentViewportBBox = viewportBBox(
      deferredSettings.center,
      deferredSettings.zoomHint,
      deferredSettings.width,
      deferredSettings.height,
    );
    // Pattern projection is linear in longitude/latitude, so derive overscan
    // from the foreground box in that same coordinate space. This makes the
    // center third pixel-identical in position and scale to the foreground.
    const previewViewportBBox = expandedPreviewBBox(
      currentViewportBBox,
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

    source
      .load({
        bbox: previewViewportBBox,
        center: deferredSettings.center,
        zoomHint: deferredSettings.zoomHint,
        roadZoomHint,
      })
      .then((previewSourceData) => {
        if (cancelled) {
          return;
        }

        const previewFeatures = filterFeaturesToBBox(
          previewSourceData.features,
          previewViewportBBox,
        );
        const compiledPreview = compilePreparedPattern({
          curation: curateFeatures(previewFeatures, {
            bbox: previewViewportBBox,
            width: previewWidth,
            height: previewHeight,
            detailLevel: deferredSettings.detailLevel,
            includeMinorRoads: true,
            roadNetworkDetail: deferredSettings.roadNetworkDetail,
          }),
          options: {
            title: `${previewSourceData.title} Preview`,
            width: previewWidth,
            height: previewHeight,
            bbox: previewViewportBBox,
            includeMinorRoads: true,
          },
        });

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setCompiledViewport((current) =>
            current?.renderRequestKey === renderRequestKey
              ? { ...current, preview: compiledPreview }
              : current,
          );
        });
      })
      .catch(() => {
        // The visible pattern is already usable; retain it if overscan fails.
      });

    return () => {
      cancelled = true;
    };
  }, [
    deferredSettings.center,
    deferredSettings.detailLevel,
    deferredSettings.height,
    deferredSettings.roadNetworkDetail,
    deferredSettings.width,
    deferredSettings.zoomHint,
    renderedForegroundKey,
    sourceData,
  ]);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      if (wheelZoomFeedbackResetRef.current !== null) {
        window.clearTimeout(wheelZoomFeedbackResetRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const frame = previewFrameRef.current;
    if (!frame) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => handlePreviewWheel(event);
    frame.addEventListener("wheel", handleWheel, { passive: false });
    return () => frame.removeEventListener("wheel", handleWheel);
  });

  useEffect(() => {
    function closeSearchResults(event: PointerEvent) {
      if (!searchResults.length) {
        return;
      }

      const target = event.target;
      if (target instanceof Node && searchFormRef.current?.contains(target)) {
        return;
      }

      setSearchResults([]);
    }

    document.addEventListener("pointerdown", closeSearchResults);
    return () =>
      document.removeEventListener("pointerdown", closeSearchResults);
  }, [searchResults.length]);

  function updateSettings<K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function clearWheelFeedbackReset() {
    if (wheelZoomFeedbackResetRef.current !== null) {
      window.clearTimeout(wheelZoomFeedbackResetRef.current);
      wheelZoomFeedbackResetRef.current = null;
    }
  }

  function jumpToSearchResult(result: SearchResult) {
    setSettings((current) => ({
      ...current,
      center: {
        lat: result.lat,
        lon: result.lon,
      },
      zoomHint: searchBBoxToZoom(
        result.bbox,
        current.width,
        current.height,
        current.zoomHint,
      ),
    }));
    setSearchQuery(result.label);
    setSearchResults([]);
    setSearchError(null);
    setSearchStatus("idle");
    setPreviewMotion(null);
  }

  async function handleLocationSearch(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError("Type a place name, neighborhood, or address to search.");
      setSearchStatus("idle");
      return;
    }

    searchAbortRef.current?.abort();
    const abortController = new AbortController();
    searchAbortRef.current = abortController;

    setSearchStatus("loading");
    setSearchError(null);

    try {
      const params = new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "5",
        addressdetails: "1",
      });
      const response = await fetch(
        `${NOMINATIM_SEARCH_URL}?${params.toString()}`,
        {
          signal: abortController.signal,
          headers: {
            Accept: "application/json",
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Search failed with status ${response.status}.`);
      }

      const payload: unknown = await response.json();
      const results = Array.isArray(payload)
        ? payload
            .map(normalizeSearchResult)
            .filter((result): result is SearchResult => Boolean(result))
        : [];

      setSearchResults(results);
      setSearchStatus("done");
      setSearchError(
        results.length ? null : `No matches found for "${query}".`,
      );
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : "Unable to search for that location right now.";
      setSearchResults([]);
      setSearchStatus("done");
      setSearchError(message);
    } finally {
      if (searchAbortRef.current === abortController) {
        searchAbortRef.current = null;
      }
    }
  }

  function handleCurrentLocation() {
    if (!navigator.geolocation) {
      setSearchError("Your browser does not support location services.");
      return;
    }

    setLocationStatus("loading");
    setSearchError(null);
    setSearchResults([]);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setSettings((current) => ({
          ...current,
          center: {
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          },
        }));
        setSearchQuery("");
        setSearchStatus("idle");
        setLocationStatus("idle");
        setPreviewMotion(null);
      },
      (error) => {
        const message =
          error.code === 1
            ? "Location access was denied. Enable it in your browser settings to center the map."
            : error.code === 3
              ? "Finding your location took too long. Please try again."
              : "Unable to determine your current location.";
        setSearchError(message);
        setLocationStatus("idle");
      },
      {
        enableHighAccuracy: false,
        maximumAge: 300_000,
        timeout: 10_000,
      },
    );
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
        const aspectRatio = Math.max(
          0.5,
          current.width / Math.max(1, current.height),
        );
        const spanY = SLIPPY_VIEW_HEIGHT_TILES;
        const spanX = spanY * aspectRatio;
        const worldScale = 2 ** current.zoomHint;
        const currentWorld = lonLatToWorld(
          current.center.lon,
          current.center.lat,
          current.zoomHint,
        );
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

  function handleCanvasPointerDown(
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    let gestureStartMotion = previewMotion;
    if (
      activePreviewPointersRef.current.size === 0 &&
      wheelZoomFeedbackRef.current
    ) {
      gestureStartMotion = wheelZoomFeedbackRef.current.baseMotion;
      clearWheelFeedbackReset();
      wheelZoomFeedbackRef.current = null;
      wheelZoomDeltaRef.current = 0;
      setPreviewMotion(gestureStartMotion);
    }

    const pointer = { x: event.clientX, y: event.clientY };
    activePreviewPointersRef.current.set(event.pointerId, pointer);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (activePreviewPointersRef.current.size === 2) {
      const [firstEntry, secondEntry] = Array.from(
        activePreviewPointersRef.current.entries(),
      );
      const [firstId, firstPointer] = firstEntry;
      const [secondId, secondPointer] = secondEntry;
      const midpoint = pointerMidpoint(firstPointer, secondPointer);
      const viewportRect = previewViewportRef.current?.getBoundingClientRect();
      const baseMotion = dragRef.current?.startMotion ?? gestureStartMotion;

      pinchRef.current = {
        pointerIds: [firstId, secondId],
        baseMotion,
        anchorX: midpoint.x - (viewportRect?.left ?? 0),
        anchorY: midpoint.y - (viewportRect?.top ?? 0),
        startDistance: Math.max(1, pointerDistance(firstPointer, secondPointer)),
        scale: 1,
      };
      dragRef.current = null;
      setPreviewMotion(baseMotion);
      setIsDraggingPreview(true);
      return;
    }

    if (activePreviewPointersRef.current.size > 1) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startMotion: gestureStartMotion,
      startX: event.clientX,
      startY: event.clientY,
    };
    setIsDraggingPreview(true);
  }

  function handleCanvasPointerMove(
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) {
    if (!activePreviewPointersRef.current.has(event.pointerId)) {
      return;
    }

    activePreviewPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const pinch = pinchRef.current;
    if (pinch && pinch.pointerIds.includes(event.pointerId)) {
      const firstPointer = activePreviewPointersRef.current.get(
        pinch.pointerIds[0],
      );
      const secondPointer = activePreviewPointersRef.current.get(
        pinch.pointerIds[1],
      );
      if (!firstPointer || !secondPointer) {
        return;
      }

      const scale = Math.min(
        2 ** (MAX_MAP_ZOOM - settings.zoomHint),
        Math.max(
          2 ** (MIN_MAP_ZOOM - settings.zoomHint),
          pointerDistance(firstPointer, secondPointer) / pinch.startDistance,
        ),
      );
      pinch.scale = scale;
      setPreviewMotion(
        zoomPreviewMotion(
          pinch.baseMotion,
          pinch.anchorX,
          pinch.anchorY,
          previewBaseOffsetX,
          previewBaseOffsetY,
          scale,
        ),
      );
      return;
    }

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
      translateX:
        startMotion.translateX + (event.clientX - dragRef.current.startX),
      translateY:
        startMotion.translateY + (event.clientY - dragRef.current.startY),
    });
  }

  function finishCanvasPointer(
    event: ReactPointerEvent<HTMLCanvasElement>,
    cancelled = false,
  ) {
    if (!activePreviewPointersRef.current.has(event.pointerId)) {
      return;
    }

    activePreviewPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const pinch = pinchRef.current;
    if (pinch && pinch.pointerIds.includes(event.pointerId)) {
      activePreviewPointersRef.current.delete(event.pointerId);
      pinchRef.current = null;
      dragRef.current = null;
      setIsDraggingPreview(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const zoomDelta = cancelled ? 0 : Math.round(Math.log2(pinch.scale));
      if (zoomDelta === 0) {
        setPreviewMotion(pinch.baseMotion);
      } else {
        applyPreviewZoom(
          pinch.anchorX,
          pinch.anchorY,
          zoomDelta,
          pinch.baseMotion,
        );
      }
      return;
    }

    activePreviewPointersRef.current.delete(event.pointerId);
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
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

    if (!cancelled && (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2)) {
      setPreviewMotion({
        scale: startMotion.scale,
        translateX: startMotion.translateX + deltaX,
        translateY: startMotion.translateY + deltaY,
      });
      applyPan(deltaX, deltaY);
      return;
    }

    setPreviewMotion(
      startMotion.scale === 1 &&
        startMotion.translateX === 0 &&
        startMotion.translateY === 0
        ? null
        : startMotion,
    );
  }

  function handlePreviewWheel(event: WheelEvent) {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (activePreviewPointersRef.current.size > 0) {
      return;
    }

    const normalizedDeltaY =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * viewport.clientHeight
          : event.deltaY;
    wheelZoomDeltaRef.current += normalizedDeltaY;
    const rect = viewport.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const direction = wheelZoomDeltaRef.current < 0 ? 1 : -1;
    const canCommitZoom =
      clampZoom(settings.zoomHint + direction) !== settings.zoomHint;
    if (!canCommitZoom) {
      const feedback = wheelZoomFeedbackRef.current;
      clearWheelFeedbackReset();
      wheelZoomFeedbackRef.current = null;
      wheelZoomDeltaRef.current = 0;
      setPreviewMotion(feedback?.baseMotion ?? null);
      return;
    }

    if (Math.abs(wheelZoomDeltaRef.current) < WHEEL_ZOOM_THRESHOLD) {
      if (!wheelZoomFeedbackRef.current) {
        wheelZoomFeedbackRef.current = {
          baseMotion: previewMotion,
          direction,
        };
      } else if (wheelZoomFeedbackRef.current.direction !== direction) {
        // Keep the motion from before this wheel gesture as its baseline. If
        // the user reverses direction, previewMotion contains the temporary
        // feedback scale and must not become the value restored on idle.
        wheelZoomFeedbackRef.current.direction = direction;
      }

      const progress = Math.min(
        0.96,
        Math.abs(wheelZoomDeltaRef.current) / WHEEL_ZOOM_THRESHOLD,
      );
      const zoomFactor =
        direction > 0
          ? 1 + progress * WHEEL_ZOOM_FEEDBACK_MAX_SCALE
          : 1 / (1 + progress * WHEEL_ZOOM_FEEDBACK_MAX_SCALE);
      setPreviewMotion(
        zoomPreviewMotion(
          wheelZoomFeedbackRef.current.baseMotion,
          anchorX,
          anchorY,
          previewBaseOffsetX,
          previewBaseOffsetY,
          zoomFactor,
        ),
      );

      clearWheelFeedbackReset();
      wheelZoomFeedbackResetRef.current = window.setTimeout(() => {
        const feedback = wheelZoomFeedbackRef.current;
        const accumulatedDelta = wheelZoomDeltaRef.current;
        wheelZoomFeedbackRef.current = null;
        wheelZoomDeltaRef.current = 0;
        wheelZoomFeedbackResetRef.current = null;

        if (
          feedback &&
          Math.abs(accumulatedDelta) >= WHEEL_ZOOM_IDLE_COMMIT_THRESHOLD
        ) {
          applyPreviewZoom(
            anchorX,
            anchorY,
            feedback.direction,
            feedback.baseMotion,
          );
        } else {
          setPreviewMotion(feedback?.baseMotion ?? null);
        }
      }, 220);
      return;
    }

    const feedbackBaseMotion =
      wheelZoomFeedbackRef.current?.baseMotion ?? previewMotion;
    const zoomDelta = direction;
    wheelZoomDeltaRef.current = 0;
    wheelZoomFeedbackRef.current = null;
    clearWheelFeedbackReset();

    applyPreviewZoom(anchorX, anchorY, zoomDelta, feedbackBaseMotion);
  }

  function applyPreviewZoom(
    anchorX: number,
    anchorY: number,
    zoomDelta: number,
    baseMotionOverride: PreviewMotion | null | undefined = undefined,
  ) {
    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const normalizedX = anchorX / Math.max(1, rect.width);
    const normalizedY = anchorY / Math.max(1, rect.height);
    const nextZoom = clampZoom(settings.zoomHint + zoomDelta);
    if (nextZoom === settings.zoomHint) {
      if (baseMotionOverride !== undefined) {
        setPreviewMotion(baseMotionOverride);
      }
      return;
    }

    setSettings((current) => ({
      ...current,
      ...(() => {
        const nextZoom = clampZoom(current.zoomHint + zoomDelta);
        if (nextZoom === current.zoomHint) {
          return { zoomHint: current.zoomHint, center: current.center };
        }

        const aspectRatio = Math.max(
          0.5,
          current.width / Math.max(1, current.height),
        );
        const oldSpanY = SLIPPY_VIEW_HEIGHT_TILES;
        const oldSpanX = oldSpanY * aspectRatio;
        const currentWorld = lonLatToWorld(
          current.center.lon,
          current.center.lat,
          current.zoomHint,
        );
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
      const baseMotion =
        baseMotionOverride === undefined
          ? currentPreviewMotion
          : baseMotionOverride;
      return zoomPreviewMotion(
        baseMotion,
        anchorX,
        anchorY,
        previewBaseOffsetX,
        previewBaseOffsetY,
        zoomFactor,
      );
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

    exportCanvasPng(
      canvasRef.current,
      `${pattern.title.toLowerCase().replace(/\s+/g, "-")}-${viewMode}.png`,
      TILE_ATTRIBUTION,
    );
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
    ? `${diagnostics.fetchedTileCount}/${diagnostics.tileCount} tiles · z${diagnostics.zoom}/roads z${diagnostics.roadZoom ?? diagnostics.zoom} · ${sourceFeatureCount.toLocaleString()} normalized features · ${curatedFeatureCount.toLocaleString()} kept`
    : null;
  const orderedLegend = [
    ...legend.filter((entry) => entry.mode === "fill"),
    ...legend.filter((entry) => entry.mode === "line"),
    ...legend.filter((entry) => entry.mode === "marker"),
  ];

  const cellSize = Math.max(
    7,
    Math.min(14, Math.floor(860 / Math.max(1, settings.width))),
  );
  const previewViewportStyle =
    pattern && previewPattern
      ? {
          width: pattern.width * cellSize,
          height: pattern.height * cellSize,
        }
      : undefined;
  const previewBaseOffsetX =
    pattern && previewPattern
      ? snappedPreviewOffset(previewPattern.width, pattern.width, cellSize)
      : 0;
  const previewBaseOffsetY =
    pattern && previewPattern
      ? snappedPreviewOffset(previewPattern.height, pattern.height, cellSize)
      : 0;
  const previewCanvasStyle =
    pattern && previewPattern
      ? {
          transform: `translate(${previewBaseOffsetX + (previewMotion?.translateX ?? 0)}px, ${
            previewBaseOffsetY + (previewMotion?.translateY ?? 0)
          }px) scale(${previewMotion?.scale ?? 1})`,
          transformOrigin: "0 0",
        }
      : undefined;
  const isRenderingPreview = isRefreshingPreview || isPending;
  const stitchedWidth = stitchedSizeLabel(settings.width, settings.fabricCount);
  const stitchedHeight = stitchedSizeLabel(
    settings.height,
    settings.fabricCount,
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="eyebrow">Map-to-stitch compiler</p>
          <h1>OpenStitchMap</h1>
          <p>
            Turn map features into a printable cross stitch chart with roads as
            backstitch and landmarks as symbols.
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
                    updateSettings(
                      "width",
                      clampDimension(
                        Number(event.target.value),
                        settings.width,
                      ),
                    )
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
                    updateSettings(
                      "height",
                      clampDimension(
                        Number(event.target.value),
                        settings.height,
                      ),
                    )
                  }
                />
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
                      onChange={() => updateSettings("fabricCount", count)}
                    />
                    <span>{count} count</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="stitched-size">
              <div className="stats-title">Stitched size</div>
              <div className="stats-grid">
                <div className="stat-tile">
                  <div className="stat-value">{stitchedWidth}</div>
                  <div className="stat-label">Width</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-value">{stitchedHeight}</div>
                  <div className="stat-label">Height</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="control-group">
            <div className="control-row">
              <div className="control-label-row">
                <label htmlFor="road-network-detail">Road detail</label>
                <span>
                  {roadNetworkDetailLabel(settings.roadNetworkDetail)}
                </span>
              </div>
              <input
                className="range-input"
                id="road-network-detail"
                type="range"
                min={0}
                max={2}
                step={1}
                value={settings.roadNetworkDetail}
                aria-valuetext={roadNetworkDetailLabel(
                  settings.roadNetworkDetail,
                )}
                onInput={(event) =>
                  updateSettings(
                    "roadNetworkDetail",
                    clampRoadNetworkDetail(Number(event.currentTarget.value)),
                  )
                }
                onChange={(event) =>
                  updateSettings(
                    "roadNetworkDetail",
                    clampRoadNetworkDetail(Number(event.target.value)),
                  )
                }
              />
            </div>

            <div className="control-row">
              <div className="legend-title">Preview mode</div>
              <div
                className="segmented"
                role="tablist"
                aria-label="Preview mode"
              >
                <button
                  className={`segment ${viewMode === "chart" ? "active" : ""}`}
                  type="button"
                  onClick={() => setViewMode("chart")}
                >
                  Chart
                </button>
                <button
                  className={`segment ${viewMode === "stitched" ? "active" : ""}`}
                  type="button"
                  onClick={() => setViewMode("stitched")}
                >
                  Stitched
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="actions">
            <button
              className="button primary"
              type="button"
              onClick={handlePngExport}
            >
              Export PNG
            </button>
          </div>

          <p className="sidebar-attribution">
            <a
              href="https://github.com/davisagli/openstitchmap"
              target="_blank"
              rel="noreferrer"
            >
              View source on GitHub
            </a>
            <br />
            <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
              OpenFreeMap
            </a>{" "}
            <a
              href="https://www.openmaptiles.org/"
              target="_blank"
              rel="noreferrer"
            >
              &copy; OpenMapTiles
            </a>{" "}
            Data from{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              OpenStreetMap
            </a>
          </p>
        </section>
      </aside>

      <main className="workspace">
        <div className="workspace-header">
          <p>
            Scroll, pinch, or double-click to zoom and drag the preview to pan.
            Use the grouped legend below to hide individual areas, ways, or
            POIs from the stitched map.
          </p>

          <form
            className="location-search workspace-search"
            ref={searchFormRef}
            onSubmit={handleLocationSearch}
          >
            <div className="search-row">
              <input
                className="input"
                id="location-search"
                type="search"
                placeholder="Search for a place or address"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <button
                className="button"
                type="submit"
                disabled={searchStatus === "loading"}
              >
                {searchStatus === "loading" ? "Searching..." : "Search"}
              </button>
              <button
                className="button location-button"
                type="button"
                disabled={locationStatus === "loading"}
                onClick={handleCurrentLocation}
              >
                {locationStatus === "loading"
                  ? "Locating..."
                  : "Current location"}
              </button>
            </div>

            {searchError ? (
              <div className="search-feedback">{searchError}</div>
            ) : null}

            {searchResults.length ? (
              <div
                className="search-results"
                role="list"
                aria-label="Search results"
              >
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
          className={`preview-frame interactive ${isRenderingPreview ? "rendering" : ""}`}
          aria-label="Pattern preview"
          ref={previewFrameRef}
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
                    isDraggingPreview ? "dragging" : "draggable"
                  } ${isRefreshingPreview ? "updating" : ""}`}
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={finishCanvasPointer}
                  onPointerCancel={(event) =>
                    finishCanvasPointer(event, true)
                  }
                  onDoubleClick={handleCanvasDoubleClick}
                  style={previewCanvasStyle}
                />
              </div>
            ) : (
              <div className="empty-state">
                Preparing the first chart preview.
              </div>
            )}
          </div>
        </section>

        <section className="legend-section">
          <div className="legend-title">Legend</div>
          <div className="legend-band">
            {orderedLegend.map((entry) => (
              <button
                className={`legend-item ${hiddenLegendEntries.has(legendEntryKey(entry)) ? "inactive" : "active"}`}
                key={legendEntryKey(entry)}
                type="button"
                aria-pressed={!hiddenLegendEntries.has(legendEntryKey(entry))}
                onClick={() => toggleLegendEntry(entry)}
              >
                <div
                  className={`legend-swatch ${entry.mode}`}
                  style={
                    entry.mode === "fill"
                      ? { backgroundColor: entry.color }
                      : { color: entry.color }
                  }
                  aria-hidden="true"
                >
                  <span
                    className={`legend-symbol legend-symbol-${entry.mode}`}
                  />
                </div>
                <div className="legend-meta">
                  <strong>{entry.label}</strong>
                  <span>{entry.floss}</span>
                </div>
                <div className="legend-usage">
                  <strong>{formatLegendUsage(entry.usage)}</strong>
                  {hiddenLegendEntries.has(legendEntryKey(entry)) ? (
                    <span>Hidden</span>
                  ) : null}
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
                <div className="stat-value">
                  {diagnostics.fetchedTileCount}/{diagnostics.tileCount}
                </div>
                <div className="stat-label">Fetched tiles</div>
              </div>
              <div className="stat-tile">
                <div className="stat-value">
                  z{diagnostics.zoom}/z
                  {diagnostics.roadZoom ?? diagnostics.zoom}
                </div>
                <div className="stat-label">Area and road source zoom</div>
              </div>
              <div className="stat-tile">
                <div className="stat-value">
                  {diagnostics.totalDecodedFeatures}
                </div>
                <div className="stat-label">Decoded raw features</div>
              </div>
              <div className="stat-tile">
                <div className="stat-value">
                  {diagnostics.layerStats.length}
                </div>
                <div className="stat-label">Layers seen in fetched tiles</div>
              </div>
            </div>

            {curationStats ? (
              <>
                <div className="legend-title">Stitch curation</div>
                <div className="stats-grid diagnostics-grid">
                  <div className="stat-tile">
                    <div className="stat-value">{curatedFeatureCount}</div>
                    <div className="stat-label">
                      Features kept for the pattern
                    </div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">{droppedFeatureCount}</div>
                    <div className="stat-label">Dropped before compilation</div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">
                      {curationStats.polygonsKept}/{curationStats.linesKept}/
                      {curationStats.markersKept}
                    </div>
                    <div className="stat-label">
                      Polygons, lines, markers kept
                    </div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">
                      {curationStats.droppedSmallPolygons +
                        curationStats.droppedShortLines +
                        curationStats.droppedOverlappingLines +
                        curationStats.droppedAdjacentPaths +
                        curationStats.droppedRoadBudget}
                    </div>
                    <div className="stat-label">
                      Tiny fills and skipped ways removed
                    </div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">
                      {curationStats.roadsCollapsed}
                    </div>
                    <div className="stat-label">
                      Parallel way candidates collapsed
                    </div>
                  </div>
                  <div className="stat-tile">
                    <div className="stat-value">
                      {curationStats.droppedRoadBudget}
                    </div>
                    <div className="stat-label">
                      Road candidates outside detail budget
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            <div className="layer-band">
              {diagnostics.layerStats.slice(0, 8).map((layer) => (
                <div className="layer-item" key={layer.layerName}>
                  <strong>{layer.layerName}</strong>
                  <span>{layer.features} features</span>
                  <span>
                    {layer.polygons} polygons, {layer.lines} lines,{" "}
                    {layer.points} points
                  </span>
                  <span>
                    {layer.sampleKeys.join(", ") || "No sampled properties"}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </main>
    </div>
  );
}
