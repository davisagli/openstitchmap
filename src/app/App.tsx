import { useDeferredValue, useEffect, useRef, useState, useTransition } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import './App.css';
import type { BBox, MapFeature, Position } from '../core/osm';
import type { LoadedSourceData } from '../core/tiles/tileSource';
import { HostedVectorTileSource } from '../core/tiles/hostedVectorSource';
import { lonLatToWorld, worldToLonLat } from '../core/tiles/mercator';
import { areaPresets } from '../core/tiles/presets';
import {
  compilePattern,
  type BackstitchSmoothingLevel,
  type PatternDocument,
} from '../core/pattern/compilePattern';
import {
  curateFeatures,
  type CurateFeaturesResult,
  type DetailLevel,
} from '../core/pattern/curateFeatures';
import { drawChartPreview } from '../render/drawChartPreview';
import { drawStitchPreview } from '../render/drawStitchPreview';
import { exportCanvasPng, exportPatternJson } from '../render/exporters';

type ViewMode = 'chart' | 'stitched';

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
  fabricCount: number;
  detailLevel: DetailLevel;
  backstitchSmoothing: BackstitchSmoothingLevel;
  includeMinorRoads: boolean;
  includePoiLabels: boolean;
  zoomHint: number;
  pmtilesUrl: string;
}

const HOSTED_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const defaultAreaPreset = areaPresets[0];
const SLIPPY_VIEW_HEIGHT_TILES = 1;
const PREVIEW_OVERSCAN_FACTOR = 1.45;
const PREVIEW_PADDING = 24;

const defaultSettings: Settings = {
  center: defaultAreaPreset.center,
  width: 96,
  height: 72,
  fabricCount: 14,
  detailLevel: 'medium',
  backstitchSmoothing: 'balanced',
  includeMinorRoads: true,
  includePoiLabels: true,
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

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
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
  const [curation, setCuration] = useState<CurateFeaturesResult | null>(null);
  const [pattern, setPattern] = useState<PatternDocument | null>(null);
  const [previewPattern, setPreviewPattern] = useState<PatternDocument | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isRefreshingPreview, setIsRefreshingPreview] = useState(true);
  const [isPending, startTransition] = useTransition();

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

    startTransition(() => {
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

      const curated = curateFeatures(actualFeatures, {
        bbox: currentViewportBBox,
        width: deferredSettings.width,
        height: deferredSettings.height,
        detailLevel: deferredSettings.detailLevel,
        includeMinorRoads: deferredSettings.includeMinorRoads,
      });
      const previewCuration = curateFeatures(previewFeatures, {
        bbox: previewViewportBBox,
        width: previewWidth,
        height: previewHeight,
        detailLevel: deferredSettings.detailLevel,
        includeMinorRoads: deferredSettings.includeMinorRoads,
      });

      setCuration(curated);
      setPattern(
        compilePattern(curated.features, {
          title: `${sourceData.title} Pattern`,
          width: deferredSettings.width,
          height: deferredSettings.height,
          bbox: currentViewportBBox,
          includeMinorRoads: deferredSettings.includeMinorRoads,
          includePoiLabels: deferredSettings.includePoiLabels,
          backstitchSmoothing: deferredSettings.backstitchSmoothing,
        }),
      );
      setPreviewPattern(
        compilePattern(previewCuration.features, {
          title: `${sourceData.title} Preview`,
          width: previewWidth,
          height: previewHeight,
          bbox: previewViewportBBox,
          includeMinorRoads: deferredSettings.includeMinorRoads,
          includePoiLabels: deferredSettings.includePoiLabels,
          backstitchSmoothing: deferredSettings.backstitchSmoothing,
        }),
      );
    });
  }, [
    deferredSettings.backstitchSmoothing,
    deferredSettings.detailLevel,
    deferredSettings.height,
    deferredSettings.includeMinorRoads,
    deferredSettings.includePoiLabels,
    deferredSettings.width,
    sourceData,
  ]);

  useEffect(() => {
    if (!pattern || !previewPattern || !canvasRef.current) {
      return;
    }

    const cellSize =
      viewMode === 'chart'
        ? Math.max(7, Math.min(14, Math.floor(860 / pattern.width)))
        : Math.max(8, Math.min(18, Math.floor(920 / pattern.width)));

    if (viewMode === 'chart') {
      drawChartPreview(canvasRef.current, previewPattern, cellSize);
    } else {
      drawStitchPreview(canvasRef.current, previewPattern, cellSize);
    }

    setIsRefreshingPreview(false);
    setPreviewMotion((current) => (current ? null : current));
  }, [pattern, previewPattern, viewMode]);

  function updateSettings<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
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
    event.preventDefault();

    const viewport = previewViewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const normalizedX = anchorX / Math.max(1, rect.width);
    const normalizedY = anchorY / Math.max(1, rect.height);
    const zoomDelta = event.deltaY < 0 ? 1 : -1;
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
    const currentMotion = previewMotion ?? {
      scale: 1,
      translateX: 0,
      translateY: 0,
    };
    setPreviewMotion({
      scale: currentMotion.scale * zoomFactor,
      translateX:
        (1 - zoomFactor) * (anchorX - previewBaseOffsetX) + zoomFactor * currentMotion.translateX,
      translateY:
        (1 - zoomFactor) * (anchorY - previewBaseOffsetY) + zoomFactor * currentMotion.translateY,
    });
  }

  function handlePngExport() {
    if (!canvasRef.current || !pattern) {
      return;
    }

    exportCanvasPng(canvasRef.current, `${pattern.title.toLowerCase().replace(/\s+/g, '-')}-${viewMode}.png`);
  }

  const legend = pattern?.legend ?? [];
  const title = `${sourceData?.title ?? 'OpenFreeMap'} Selection`;
  const diagnostics = sourceData?.diagnostics;
  const sourceFeatureCount = sourceData?.features.length ?? 0;
  const curationStats = curation?.stats;
  const curatedFeatureCount = curationStats?.curatedCount ?? 0;
  const droppedFeatureCount = curationStats
    ? curationStats.originalCount - curationStats.curatedCount
    : 0;

  const cellSize =
    viewMode === 'chart'
      ? Math.max(7, Math.min(14, Math.floor(860 / Math.max(1, settings.width))))
      : Math.max(8, Math.min(18, Math.floor(920 / Math.max(1, settings.width))));
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
            <div className="legend-title">Backstitch smoothing</div>
            <div className="segmented three-up" role="tablist" aria-label="Backstitch smoothing">
              {([
                ['soft', 'Soft'],
                ['balanced', 'Balanced'],
                ['strong', 'Strong'],
              ] as const).map(([level, label]) => (
                <button
                  key={level}
                  className={`segment ${settings.backstitchSmoothing === level ? 'active' : ''}`}
                  type="button"
                  onClick={() => updateSettings('backstitchSmoothing', level)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-row">
            <label htmlFor="fabric-count">Fabric count</label>
            <div className="range-wrap">
              <input
                className="range-input"
                id="fabric-count"
                type="range"
                min={11}
                max={18}
                step={1}
                value={settings.fabricCount}
                onChange={(event) => updateSettings('fabricCount', Number(event.target.value))}
              />
              <input
                className="number-input"
                type="number"
                min={11}
                max={18}
                value={settings.fabricCount}
                onChange={(event) => updateSettings('fabricCount', Number(event.target.value))}
              />
            </div>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.includeMinorRoads}
              onChange={(event) => updateSettings('includeMinorRoads', event.target.checked)}
            />
            <span>Include minor roads and paths in the backstitch overlay.</span>
          </label>

          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.includePoiLabels}
              onChange={(event) => updateSettings('includePoiLabels', event.target.checked)}
            />
            <span>Use POI names in the exported pattern data.</span>
          </label>

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

        <div className="actions">
          <button className="button primary" type="button" onClick={handlePngExport}>
            Export PNG
          </button>
          <button
            className="button"
            type="button"
            onClick={() => {
              if (pattern) {
                exportPatternJson(pattern);
              }
            }}
          >
            Export JSON
          </button>
        </div>

        <div className="sidebar-footer">
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

          <div>
            <div className="stats-title">Current filter pass</div>
            <p>
              {settings.detailLevel[0].toUpperCase()}
              {settings.detailLevel.slice(1)} detail keeps the preview legible by
              trimming tiny fills, simplifying linework, and spacing out POI markers.
              {' '}Backstitch smoothing is set to {settings.backstitchSmoothing}.
            </p>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <div className="workspace-header">
          <div>
            <h2>{title}</h2>
            <p>
              Drag the preview to pan and use the mouse wheel to zoom. We are
              rendering directly from OpenFreeMap so choosing the area to stitch
              feels more like navigating a map than picking from presets.
            </p>
          </div>
          <div className="hint">
            {isPending || isRefreshingPreview
              ? 'Refreshing pattern preview...'
              : `Zoom ${settings.zoomHint} · ${settings.width} × ${settings.height} stitches, ${legend.length} legend entries`}
          </div>
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
                <div className="preview-overlay">
                  {isRefreshingPreview ? 'Updating preview...' : 'Drag to pan. Scroll to zoom.'}
                </div>
                <canvas
                  className={`preview-canvas ${
                    isDraggingPreview ? 'dragging' : 'draggable'
                  } ${isRefreshingPreview ? 'updating' : ''}`}
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={finishCanvasDrag}
                  onPointerCancel={finishCanvasDrag}
                  style={previewCanvasStyle}
                />
              </div>
            ) : (
              <div className="empty-state">Preparing the first chart preview.</div>
            )}
          </div>
        </section>

        {diagnostics ? (
          <section>
            <div className="legend-title">Source diagnostics</div>
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
                        curationStats.droppedAdjacentPaths}
                    </div>
                    <div className="stat-label">Tiny fills and thinned ways removed</div>
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
          </section>
        ) : null}

        <section>
          <div className="legend-title">Legend</div>
          <div className="legend-band">
            {legend.map((entry) => (
              <div className="legend-item" key={`${entry.mode}:${entry.id}`}>
                <div
                  className="legend-swatch"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden="true"
                >
                  {entry.symbol}
                </div>
                <div className="legend-meta">
                  <strong>{entry.label}</strong>
                  <span>{entry.floss}</span>
                </div>
                <div className="legend-usage">
                  <strong>{entry.usage}</strong>
                  <span>{entry.mode}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
