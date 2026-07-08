import type { BBox, LineFeature, MapFeature, PointFeature, PolygonFeature, Position } from '../osm';
import {
  fillStyles,
  lineStyles,
  markerStyles,
  type FillStyle,
  type FillStyleId,
  type LineStyleId,
  type MarkerStyleId,
} from '../palette';

export interface PatternCell {
  fill: FillStyleId;
  color: string;
  symbol: string;
  floss: string;
  label: string;
  fractional: PatternCellFraction | null;
}

export type PatternCellCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface PatternCellFraction {
  kind: 'threeQuarter';
  shortCorner: PatternCellCorner;
  accent: PatternCellSample;
}

export interface PatternCellSample {
  corner: PatternCellCorner;
  fill: FillStyleId;
  color: string;
  symbol: string;
  floss: string;
  label: string;
}

export interface GridPoint {
  x: number;
  y: number;
}

export interface BackstitchSegment {
  id: string;
  kind: LineStyleId;
  color: string;
  floss: string;
  weight: number;
  from: GridPoint;
  to: GridPoint;
  label: string;
}

export interface PatternMarker {
  id: string;
  kind: MarkerStyleId;
  color: string;
  symbol: string;
  label: string;
  position: GridPoint;
}

export interface LegendEntry {
  id: string;
  label: string;
  symbol: string;
  color: string;
  floss: string;
  usage: number;
  mode: 'fill' | 'line' | 'marker';
}

export interface PatternDocument {
  title: string;
  width: number;
  height: number;
  bbox: BBox;
  cells: PatternCell[][];
  backstitches: BackstitchSegment[];
  markers: PatternMarker[];
  legend: LegendEntry[];
}

export interface CompilePatternOptions {
  title: string;
  width: number;
  height: number;
  bbox: BBox;
  includeMinorRoads: boolean;
}

interface StyledPolygon {
  feature: PolygonFeature;
  style: FillStyle;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(left: GridPoint, right: GridPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function perpendicularDistance(point: GridPoint, start: GridPoint, end: GridPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return distance(point, start);
  }

  const numerator = Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x);
  const denominator = Math.hypot(dx, dy);
  return numerator / denominator;
}

function douglasPeuckerIndexes(points: GridPoint[], tolerance: number): number[] {
  if (points.length <= 2) {
    return points.map((_, index) => index);
  }

  let maxDistance = 0;
  let splitIndex = -1;

  for (let index = 1; index < points.length - 1; index += 1) {
    const candidateDistance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (candidateDistance > maxDistance) {
      maxDistance = candidateDistance;
      splitIndex = index;
    }
  }

  if (maxDistance <= tolerance || splitIndex === -1) {
    return [0, points.length - 1];
  }

  const left = douglasPeuckerIndexes(points.slice(0, splitIndex + 1), tolerance);
  const right = douglasPeuckerIndexes(points.slice(splitIndex), tolerance).map((index) => index + splitIndex);
  return [...left.slice(0, -1), ...right];
}

function dedupeGridPoints(points: GridPoint[]): GridPoint[] {
  if (!points.length) {
    return points;
  }

  const deduped = [points[0]];

  for (let index = 1; index < points.length; index += 1) {
    const previous = deduped[deduped.length - 1];
    const current = points[index];
    if (previous.x !== current.x || previous.y !== current.y) {
      deduped.push(current);
    }
  }

  return deduped;
}

function lineSimplifyTolerance(kind: LineStyleId): number {
  switch (kind) {
    case 'primaryRoad':
      return 0.85;
    case 'rail':
      return 0.75;
    case 'secondaryRoad':
      return 0.65;
    case 'stream':
    case 'boundary':
      return 0.45;
    case 'path':
      return 0.35;
    default:
      return 0.5;
  }
}

function snapAndSimplifyLine(
  coordinates: Position[],
  bbox: BBox,
  width: number,
  height: number,
  kind: LineStyleId,
): GridPoint[] {
  const snapped = dedupeGridPoints(
    coordinates.map((point) => {
      const projected = projectToGrid(point, bbox, width, height);
      return {
        x: Math.round(projected.x),
        y: Math.round(projected.y),
      };
    }),
  );

  if (snapped.length <= 2) {
    return snapped;
  }

  const indexes = Array.from(new Set(douglasPeuckerIndexes(snapped, lineSimplifyTolerance(kind)))).sort(
    (left, right) => left - right,
  );
  return indexes.map((index) => snapped[index]);
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-9) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInPolygon(point: Position, rings: Position[][]): boolean {
  if (!rings.length || !pointInRing(point, rings[0])) {
    return false;
  }

  for (let index = 1; index < rings.length; index += 1) {
    if (pointInRing(point, rings[index])) {
      return false;
    }
  }

  return true;
}

function projectToGrid(point: Position, bbox: BBox, width: number, height: number): GridPoint {
  const x = ((point[0] - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * width;
  const y = (1 - (point[1] - bbox.minLat) / (bbox.maxLat - bbox.minLat)) * height;

  return {
    x: clamp(x, 0, width),
    y: clamp(y, 0, height),
  };
}

function cellCenterToPosition(x: number, y: number, bbox: BBox, width: number, height: number): Position {
  return [
    bbox.minLon + ((x + 0.5) / width) * (bbox.maxLon - bbox.minLon),
    bbox.maxLat - ((y + 0.5) / height) * (bbox.maxLat - bbox.minLat),
  ];
}

function cellOffsetToPosition(
  x: number,
  y: number,
  offsetX: number,
  offsetY: number,
  bbox: BBox,
  width: number,
  height: number,
): Position {
  return [
    bbox.minLon + ((x + offsetX) / width) * (bbox.maxLon - bbox.minLon),
    bbox.maxLat - ((y + offsetY) / height) * (bbox.maxLat - bbox.minLat),
  ];
}

function styleAtPosition(point: Position, polygons: StyledPolygon[]): FillStyle {
  let fill = fillStyles.ground;

  for (const polygon of polygons) {
    if (pointInPolygon(point, polygon.feature.coordinates)) {
      fill = polygon.style;
    }
  }

  return fill;
}

function sampleFromStyle(
  style: FillStyle,
  corner: PatternCellCorner,
): PatternCellSample {
  return {
    corner,
    fill: style.id,
    color: style.color,
    symbol: style.symbol,
    floss: style.floss,
    label: style.label,
  };
}

function dominantStyle(samples: PatternCellSample[]): PatternCellSample {
  const counts = new Map<FillStyleId, number>();

  for (const sample of samples) {
    counts.set(sample.fill, (counts.get(sample.fill) ?? 0) + 1);
  }

  const [winner] = Array.from(counts.entries()).sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return fillStyles[right[0]].priority - fillStyles[left[0]].priority;
  });

  return sampleFromStyle(fillStyles[winner[0]], samples[0].corner);
}

function oppositeCorner(corner: PatternCellCorner): PatternCellCorner {
  switch (corner) {
    case 'topLeft':
      return 'bottomRight';
    case 'topRight':
      return 'bottomLeft';
    case 'bottomLeft':
      return 'topRight';
    case 'bottomRight':
      return 'topLeft';
  }
}

function cornerNeighborOffsets(corner: PatternCellCorner): Array<[number, number]> {
  switch (corner) {
    case 'topLeft':
      return [
        [0, -1],
        [-1, 0],
      ];
    case 'topRight':
      return [
        [0, -1],
        [1, 0],
      ];
    case 'bottomLeft':
      return [
        [0, 1],
        [-1, 0],
      ];
    case 'bottomRight':
      return [
        [0, 1],
        [1, 0],
      ];
  }
}

function supportsThreeQuarterFraction(
  cells: PatternCell[][],
  x: number,
  y: number,
  fraction: PatternCellFraction,
): boolean {
  const accentCorner = oppositeCorner(fraction.shortCorner);
  const accentSupported = cornerNeighborOffsets(accentCorner).every(([offsetX, offsetY]) => {
    const neighbor = cells[y + offsetY]?.[x + offsetX];
    return neighbor?.fill === fraction.accent.fill;
  });
  const dominantSupported = cornerNeighborOffsets(fraction.shortCorner).every(([offsetX, offsetY]) => {
    const neighbor = cells[y + offsetY]?.[x + offsetX];
    return neighbor?.fill === cells[y][x].fill;
  });

  return accentSupported && dominantSupported;
}

function threeQuarterFraction(samples: PatternCellSample[]): PatternCellFraction | null {
  const fillGroups = new Map<FillStyleId, PatternCellSample[]>();

  for (const sample of samples) {
    const group = fillGroups.get(sample.fill);
    if (group) {
      group.push(sample);
    } else {
      fillGroups.set(sample.fill, [sample]);
    }
  }

  if (fillGroups.size !== 2) {
    return null;
  }

  const dominantGroup = Array.from(fillGroups.values()).sort((left, right) => right.length - left.length)[0];

  if (dominantGroup.length !== 3) {
    return null;
  }

  const accent = samples.find((sample) => sample.fill !== dominantGroup[0].fill);
  if (!accent) {
    return null;
  }

  return {
    kind: 'threeQuarter',
    shortCorner: oppositeCorner(accent.corner),
    accent,
  };
}

export function classifyPolygon(feature: PolygonFeature): FillStyle | null {
  if (feature.tags.natural === 'water' || feature.tags.water === 'lake') {
    return fillStyles.water;
  }

  if (feature.tags.leisure === 'park' || feature.tags.landuse === 'grass') {
    return fillStyles.park;
  }

  if (feature.tags.natural === 'wood' || feature.tags.landuse === 'forest') {
    return fillStyles.forest;
  }

  if (feature.tags.landuse === 'farmland' || feature.tags.landuse === 'allotments') {
    return fillStyles.farmland;
  }

  if (feature.tags.building === 'yes' || feature.tags.building === 'public') {
    return fillStyles.building;
  }

  return null;
}

export function classifyLine(feature: LineFeature): LineStyleId | null {
  const highway = feature.tags.highway;

  if (
    highway === 'primary' ||
    highway === 'trunk' ||
    highway === 'motorway' ||
    highway === 'motorway_link' ||
    highway === 'trunk_link' ||
    highway === 'primary_link'
  ) {
    return 'primaryRoad';
  }

  if (
    highway === 'secondary' ||
    highway === 'secondary_link' ||
    highway === 'tertiary' ||
    highway === 'tertiary_link' ||
    highway === 'residential' ||
    highway === 'service'
  ) {
    return 'secondaryRoad';
  }

  if (highway === 'path' || highway === 'footway' || highway === 'cycleway') {
    return 'path';
  }

  if (feature.tags.railway) {
    return 'rail';
  }

  if (feature.tags.waterway) {
    return 'stream';
  }

  if (feature.tags.boundary) {
    return 'boundary';
  }

  return null;
}

export function classifyMarker(feature: PointFeature): MarkerStyleId | null {
  if (feature.tags.amenity === 'cafe') {
    return 'cafe';
  }

  if (feature.tags.railway === 'station' || feature.tags.public_transport === 'station') {
    return 'station';
  }

  if (feature.tags.tourism === 'viewpoint' || feature.tags.natural === 'peak') {
    return 'viewpoint';
  }

  if (feature.tags.tourism === 'museum') {
    return 'museum';
  }

  if (feature.tags.amenity === 'hospital') {
    return 'hospital';
  }

  return null;
}

function buildLegend(
  cells: PatternCell[][],
  backstitches: BackstitchSegment[],
  markers: PatternMarker[],
): LegendEntry[] {
  const fillCounts = new Map<FillStyleId, number>();
  const lineCounts = new Map<LineStyleId, number>();
  const markerCounts = new Map<MarkerStyleId, number>();

  for (const row of cells) {
    for (const cell of row) {
      if (cell.fractional?.kind === 'threeQuarter') {
        fillCounts.set(cell.fill, (fillCounts.get(cell.fill) ?? 0) + 0.75);
        fillCounts.set(
          cell.fractional.accent.fill,
          (fillCounts.get(cell.fractional.accent.fill) ?? 0) + 0.25,
        );
      } else {
        fillCounts.set(cell.fill, (fillCounts.get(cell.fill) ?? 0) + 1);
      }
    }
  }

  for (const segment of backstitches) {
    lineCounts.set(segment.kind, (lineCounts.get(segment.kind) ?? 0) + 1);
  }

  for (const marker of markers) {
    markerCounts.set(marker.kind, (markerCounts.get(marker.kind) ?? 0) + 1);
  }

  const legend: LegendEntry[] = [];

  for (const [id, usage] of fillCounts) {
    const style = fillStyles[id];
    legend.push({
      id,
      label: style.label,
      symbol: style.symbol,
      color: style.color,
      floss: style.floss,
      usage,
      mode: 'fill',
    });
  }

  for (const [id, usage] of lineCounts) {
    const style = lineStyles[id];
    legend.push({
      id,
      label: style.label,
      symbol: '—',
      color: style.color,
      floss: style.floss,
      usage,
      mode: 'line',
    });
  }

  for (const [id, usage] of markerCounts) {
    const style = markerStyles[id];
    legend.push({
      id,
      label: style.label,
      symbol: style.symbol,
      color: style.color,
      floss: style.floss,
      usage,
      mode: 'marker',
    });
  }

  return legend.sort((left, right) => left.label.localeCompare(right.label));
}

export function compilePattern(
  features: MapFeature[],
  options: CompilePatternOptions,
): PatternDocument {
  const polygons: StyledPolygon[] = features
    .filter((feature): feature is PolygonFeature => feature.type === 'polygon')
    .map((feature) => {
      const style = classifyPolygon(feature);
      return style ? { feature, style } : null;
    })
    .filter((item): item is StyledPolygon => item !== null)
    .sort((left, right) => left.style.priority - right.style.priority);

  const cells: PatternCell[][] = Array.from({ length: options.height }, (_, y) =>
    Array.from({ length: options.width }, (_, x) => {
      const sampleOffsets: Array<[PatternCellCorner, number, number]> = [
        ['topLeft', 0.25, 0.25],
        ['topRight', 0.75, 0.25],
        ['bottomLeft', 0.25, 0.75],
        ['bottomRight', 0.75, 0.75],
      ];
      const samples = sampleOffsets.map(([corner, offsetX, offsetY]) =>
        sampleFromStyle(
          styleAtPosition(
            cellOffsetToPosition(x, y, offsetX, offsetY, options.bbox, options.width, options.height),
            polygons,
          ),
          corner,
        ),
      );
      const fill = dominantStyle(samples);
      const centerFill = sampleFromStyle(
        styleAtPosition(
          cellCenterToPosition(x, y, options.bbox, options.width, options.height),
          polygons,
        ),
        fill.corner,
      );
      const isUniform = samples.every((sample) => sample.fill === samples[0].fill);
      const fraction = isUniform ? null : threeQuarterFraction(samples);
      const displayFill =
        isUniform || fraction ? fill : centerFill.fill === fill.fill ? fill : centerFill;

      return {
        fill: displayFill.fill,
        color: displayFill.color,
        symbol: displayFill.symbol,
        floss: displayFill.floss,
        label: displayFill.label,
        fractional: fraction,
      };
    }),
  );

  const refinedCells = cells.map((row, y) =>
    row.map((cell, x) => {
      if (!cell.fractional || supportsThreeQuarterFraction(cells, x, y, cell.fractional)) {
        return cell;
      }

      return {
        ...cell,
        fractional: null,
      };
    }),
  );

  const backstitches: BackstitchSegment[] = [];
  const markers: PatternMarker[] = [];

  for (const feature of features) {
    if (feature.type === 'line') {
      const kind = classifyLine(feature);
      if (!kind) {
        continue;
      }
      if (!options.includeMinorRoads && (kind === 'secondaryRoad' || kind === 'path')) {
        continue;
      }

      const style = lineStyles[kind];
      const simplifiedPath = snapAndSimplifyLine(
        feature.coordinates,
        options.bbox,
        options.width,
        options.height,
        kind,
      );

      for (let index = 1; index < simplifiedPath.length; index += 1) {
        const from = simplifiedPath[index - 1];
        const to = simplifiedPath[index];

        if (from.x === to.x && from.y === to.y) {
          continue;
        }

        backstitches.push({
          id: `${feature.id}:${index}`,
          kind,
          color: style.color,
          floss: style.floss,
          weight: style.weight,
          from,
          to,
          label: feature.name ?? style.label,
        });
      }
    }

    if (feature.type === 'point') {
      const kind = classifyMarker(feature);
      if (!kind) {
        continue;
      }

      const style = markerStyles[kind];
      const position = projectToGrid(feature.coordinates, options.bbox, options.width, options.height);

      markers.push({
        id: feature.id,
        kind,
        color: style.color,
        symbol: style.symbol,
        label: style.label,
        position: {
          x: clamp(Math.floor(position.x), 0, options.width - 1) + 0.5,
          y: clamp(Math.floor(position.y), 0, options.height - 1) + 0.5,
        },
      });
    }
  }

  return {
    title: options.title,
    width: options.width,
    height: options.height,
    bbox: options.bbox,
    cells: refinedCells,
    backstitches,
    markers,
    legend: buildLegend(refinedCells, backstitches, markers),
  };
}
