import { useDeferredValue, useEffect, useRef, useState, useTransition } from 'react';
import './App.css';
import { DemoTileSource, type LoadedSourceData } from '../core/tiles/tileSource';
import { HostedVectorTileSource } from '../core/tiles/hostedVectorSource';
import { PMTilesVectorSource } from '../core/tiles/pmtilesSource';
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
type SourceMode = 'hosted' | 'pmtiles' | 'demo';

interface Settings {
  areaPresetId: string;
  sourceMode: SourceMode;
  width: number;
  height: number;
  fabricCount: number;
  detailLevel: DetailLevel;
  backstitchSmoothing: BackstitchSmoothingLevel;
  includeMinorRoads: boolean;
  includePoiLabels: boolean;
  zoomHint: number;
  tileSpan: number;
  pmtilesUrl: string;
}

const HOSTED_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const PMTILES_EXAMPLE_URL = 'https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles';
const defaultAreaPreset = areaPresets[0];

const defaultSettings: Settings = {
  areaPresetId: defaultAreaPreset.id,
  sourceMode: 'hosted',
  width: 96,
  height: 72,
  fabricCount: 14,
  detailLevel: 'medium',
  backstitchSmoothing: 'balanced',
  includeMinorRoads: true,
  includePoiLabels: true,
  zoomHint: defaultAreaPreset.zoom,
  tileSpan: defaultAreaPreset.tileSpan,
  pmtilesUrl: PMTILES_EXAMPLE_URL,
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

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('chart');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const deferredSettings = useDeferredValue(settings);
  const [sourceData, setSourceData] = useState<LoadedSourceData | null>(null);
  const [curation, setCuration] = useState<CurateFeaturesResult | null>(null);
  const [pattern, setPattern] = useState<PatternDocument | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    const areaPreset =
      areaPresets.find((preset) => preset.id === deferredSettings.areaPresetId) ?? defaultAreaPreset;
    const source =
      deferredSettings.sourceMode === 'hosted'
        ? new HostedVectorTileSource(HOSTED_TILEJSON_URL, 'OpenFreeMap')
        : deferredSettings.sourceMode === 'pmtiles'
          ? new PMTilesVectorSource(deferredSettings.pmtilesUrl)
          : new DemoTileSource();

    setSourceError(null);

    source
      .load({
        center: areaPreset.center,
        zoomHint: deferredSettings.zoomHint,
        tileSpan: deferredSettings.tileSpan,
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
          setSourceError(message);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    deferredSettings.areaPresetId,
    deferredSettings.pmtilesUrl,
    deferredSettings.sourceMode,
    deferredSettings.tileSpan,
    deferredSettings.zoomHint,
  ]);

  useEffect(() => {
    if (!sourceData) {
      return;
    }

    startTransition(() => {
      const curated = curateFeatures(sourceData.features, {
        bbox: sourceData.bbox,
        width: deferredSettings.width,
        height: deferredSettings.height,
        detailLevel: deferredSettings.detailLevel,
        includeMinorRoads: deferredSettings.includeMinorRoads,
      });

      setCuration(curated);
      setPattern(
        compilePattern(curated.features, {
          title: `${sourceData.title} Pattern`,
          width: deferredSettings.width,
          height: deferredSettings.height,
          bbox: sourceData.bbox,
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
    if (!pattern || !canvasRef.current) {
      return;
    }

    const cellSize =
      viewMode === 'chart'
        ? Math.max(7, Math.min(14, Math.floor(860 / pattern.width)))
        : Math.max(8, Math.min(18, Math.floor(920 / pattern.width)));

    if (viewMode === 'chart') {
      drawChartPreview(canvasRef.current, pattern, cellSize);
      return;
    }

    drawStitchPreview(canvasRef.current, pattern, cellSize);
  }, [pattern, viewMode]);

  function updateSettings<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function applyAreaPreset(presetId: string) {
    const preset = areaPresets.find((candidate) => candidate.id === presetId);
    if (!preset) {
      return;
    }

    setSettings((current) => ({
      ...current,
      areaPresetId: preset.id,
      zoomHint: preset.zoom,
      tileSpan: preset.tileSpan,
    }));
  }

  function handlePngExport() {
    if (!canvasRef.current || !pattern) {
      return;
    }

    exportCanvasPng(canvasRef.current, `${pattern.title.toLowerCase().replace(/\s+/g, '-')}-${viewMode}.png`);
  }

  const legend = pattern?.legend ?? [];
  const activeAreaPreset = areaPresets.find((preset) => preset.id === settings.areaPresetId) ?? defaultAreaPreset;
  const title =
    settings.sourceMode === 'demo'
      ? sourceData?.title ?? 'Waiting for data'
      : `${activeAreaPreset.label} · ${sourceData?.title ?? 'Loading source'}`;
  const diagnostics = sourceData?.diagnostics;
  const sourceFeatureCount = sourceData?.features.length ?? 0;
  const curationStats = curation?.stats;
  const curatedFeatureCount = curationStats?.curatedCount ?? 0;
  const droppedFeatureCount = curationStats
    ? curationStats.originalCount - curationStats.curatedCount
    : 0;

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
          <div className="control-row">
            <label htmlFor="dataset">Dataset</label>
            <select
              className="select"
              id="dataset"
              value={settings.sourceMode}
              onChange={(event) => updateSettings('sourceMode', event.target.value as SourceMode)}
            >
              <option value="hosted">Hosted vector tiles</option>
              <option value="pmtiles">Live PMTiles archive</option>
              <option value="demo">Seattle-inspired demo</option>
            </select>
          </div>

          {settings.sourceMode !== 'demo' ? (
            <>
              <div className="control-row">
                <label htmlFor="area-preset">Area preset</label>
                <select
                  className="select"
                  id="area-preset"
                  value={settings.areaPresetId}
                  onChange={(event) => applyAreaPreset(event.target.value)}
                >
                  {areaPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>

              {settings.sourceMode === 'hosted' ? (
                <div className="control-row">
                  <label htmlFor="hosted-provider">Hosted source</label>
                  <input
                    className="input"
                    id="hosted-provider"
                    type="text"
                    value="OpenFreeMap public vector tiles"
                    disabled
                  />
                </div>
              ) : null}

              {settings.sourceMode === 'pmtiles' ? (
                <div className="control-row">
                  <label htmlFor="pmtiles-url">PMTiles URL</label>
                  <input
                    className="input"
                    id="pmtiles-url"
                    type="text"
                    value={settings.pmtilesUrl}
                    onChange={(event) => updateSettings('pmtilesUrl', event.target.value)}
                  />
                </div>
              ) : null}

              <div className="control-row">
                <label htmlFor="zoom-hint">Tile zoom</label>
                <div className="range-wrap">
                  <input
                    className="range-input"
                    id="zoom-hint"
                    type="range"
                    min={10}
                    max={16}
                    step={1}
                    value={settings.zoomHint}
                    onChange={(event) => updateSettings('zoomHint', Number(event.target.value))}
                  />
                  <input
                    className="number-input"
                    type="number"
                    min={10}
                    max={16}
                    value={settings.zoomHint}
                    onChange={(event) => updateSettings('zoomHint', Number(event.target.value))}
                  />
                </div>
              </div>

              <div className="control-row">
                <label htmlFor="tile-span">Tile span</label>
                <div className="range-wrap">
                  <input
                    className="range-input"
                    id="tile-span"
                    type="range"
                    min={1}
                    max={4}
                    step={1}
                    value={settings.tileSpan}
                    onChange={(event) => updateSettings('tileSpan', Number(event.target.value))}
                  />
                  <input
                    className="number-input"
                    type="number"
                    min={1}
                    max={4}
                    value={settings.tileSpan}
                    onChange={(event) => updateSettings('tileSpan', Number(event.target.value))}
                  />
                </div>
              </div>
            </>
          ) : null}

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
              {settings.sourceMode === 'hosted'
                ? 'Rendering from a hosted global vector source so you can inspect familiar Seattle geometry without downloading an archive first.'
                : settings.sourceMode === 'pmtiles'
                  ? 'Rendering directly from a PMTiles archive so we can study the real vector layers that need stitch-friendly simplification.'
                  : 'The local demo remains here as a stable fallback while the live tile path gets sharper.'}
            </p>
          </div>
          <div className="hint">
            {isPending
              ? 'Refreshing pattern preview...'
              : `${settings.width} × ${settings.height} stitches, ${legend.length} legend entries`}
          </div>
        </div>

        <section className="preview-frame" aria-label="Pattern preview">
          <div className="preview-center">
            {sourceError ? (
              <div className="empty-state">
                <strong>Source load failed.</strong>
                <div>{sourceError}</div>
              </div>
            ) : pattern ? (
              <canvas className="preview-canvas" ref={canvasRef} />
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
