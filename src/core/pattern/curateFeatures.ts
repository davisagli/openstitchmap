import type { BBox, LineFeature, MapFeature, PointFeature, PolygonFeature, Position } from '../osm';
import { classifyLine, classifyMarker, classifyPolygon } from './compilePattern';

export type DetailLevel = 'low' | 'medium' | 'high';

export interface CurateFeaturesOptions {
  bbox: BBox;
  width: number;
  height: number;
  detailLevel: DetailLevel;
  includeMinorRoads: boolean;
  roadNetworkDetail: number;
  roadNetworkMode?: 'graph' | 'sourceZoom';
}

export interface CurateFeaturesStats {
  originalCount: number;
  curatedCount: number;
  polygonsKept: number;
  linesKept: number;
  markersKept: number;
  droppedUnclassified: number;
  droppedSmallPolygons: number;
  droppedShortLines: number;
  droppedOverlappingLines: number;
  droppedAdjacentPaths: number;
  droppedRoadBudget: number;
  roadsCollapsed: number;
  droppedCrowdedMarkers: number;
  droppedMarkerBudget: number;
}

export interface CurateFeaturesResult {
  features: MapFeature[];
  stats: CurateFeaturesStats;
}

interface DetailProfile {
  maxMarkers: number;
  markerMinDistance: number;
  minBuildingAreaCells: number;
  minLandAreaCells: number;
  minLineLengthCells: number;
  simplifyTolerance: number;
}

const detailProfiles: Record<DetailLevel, DetailProfile> = {
  low: {
    maxMarkers: 16,
    markerMinDistance: 10,
    minBuildingAreaCells: 3,
    minLandAreaCells: 2.5,
    minLineLengthCells: 7,
    simplifyTolerance: 1.75,
  },
  medium: {
    maxMarkers: 28,
    markerMinDistance: 7,
    minBuildingAreaCells: 1.8,
    minLandAreaCells: 1.4,
    minLineLengthCells: 4,
    simplifyTolerance: 1.1,
  },
  high: {
    maxMarkers: 42,
    markerMinDistance: 5,
    minBuildingAreaCells: 0.9,
    minLandAreaCells: 0.8,
    minLineLengthCells: 2.2,
    simplifyTolerance: 0.55,
  },
};

interface GridPoint {
  x: number;
  y: number;
}

interface GridCell {
  x: number;
  y: number;
}

interface ProjectedWaterPolygon {
  rings: GridPoint[][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface LineCandidate {
  id: string;
  feature: LineFeature;
  kind: NonNullable<ReturnType<typeof classifyLine>>;
  coordinates: Position[];
  projected: GridPoint[];
  rank: number;
  length: number;
}

type GraphRoadRole = 'corridor' | 'connector' | 'duplicate' | 'local';

interface RoadSelectionProfile {
  maxRoads: number;
  connectorReserve: number;
  aggregationRounds: number;
  minimumScore: number;
}

interface RoadSelectionResult {
  selectedIds: Set<string>;
  droppedBudget: number;
}

interface GraphCandidateStats {
  branchingEndpoints: number;
  junctionCount: number;
  maxDegree: number;
  importance: number;
  touchesPrimary: boolean;
}

interface SnappedRoadGraph {
  candidateCells: Map<string, GridCell[]>;
  nodeDegrees: Map<string, number>;
  candidateRoles: Map<string, GraphRoadRole>;
  candidateImportance: Map<string, number>;
  duplicateAnchors: Map<string, string>;
  candidateStats: Map<string, GraphCandidateStats>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function projectToGrid(point: Position, bbox: BBox, width: number, height: number): GridPoint {
  const x = ((point[0] - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * width;
  const y = (1 - (point[1] - bbox.minLat) / (bbox.maxLat - bbox.minLat)) * height;
  return {
    x: clamp(x, 0, width),
    y: clamp(y, 0, height),
  };
}

function unprojectFromGrid(point: GridPoint, bbox: BBox, width: number, height: number): Position {
  return [
    bbox.minLon + (point.x / width) * (bbox.maxLon - bbox.minLon),
    bbox.maxLat - (point.y / height) * (bbox.maxLat - bbox.minLat),
  ];
}

function distance(left: GridPoint, right: GridPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function cellKey(cell: GridCell): string {
  return `${cell.x}:${cell.y}`;
}

function snapToGrid(point: GridPoint): GridCell {
  return {
    x: Math.round(point.x),
    y: Math.round(point.y),
  };
}

function lineLength(points: GridPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1], points[index]);
  }
  return total;
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

function simplifyCoordinates(
  coordinates: Position[],
  bbox: BBox,
  width: number,
  height: number,
  tolerance: number,
): Position[] {
  if (coordinates.length <= 2) {
    return coordinates;
  }

  const projected = coordinates.map((point) => projectToGrid(point, bbox, width, height));
  const indexes = Array.from(new Set(douglasPeuckerIndexes(projected, tolerance))).sort((left, right) => left - right);
  return indexes.map((index) => coordinates[index]);
}

function polygonAreaInCells(feature: PolygonFeature, bbox: BBox, width: number, height: number): number {
  const outerRing = feature.coordinates[0];
  if (!outerRing || outerRing.length < 4) {
    return 0;
  }

  const projected = outerRing.map((point) => projectToGrid(point, bbox, width, height));
  let area = 0;
  for (let index = 0; index < projected.length - 1; index += 1) {
    area += projected[index].x * projected[index + 1].y - projected[index + 1].x * projected[index].y;
  }
  return Math.abs(area) / 2;
}

function pointInRing(point: GridPoint, ring: GridPoint[]): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const { x: xi, y: yi } = ring[i];
    const { x: xj, y: yj } = ring[j];
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-9) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInProjectedWater(point: GridPoint, polygon: ProjectedWaterPolygon): boolean {
  if (
    point.x < polygon.minX ||
    point.x > polygon.maxX ||
    point.y < polygon.minY ||
    point.y > polygon.maxY ||
    !pointInRing(point, polygon.rings[0])
  ) {
    return false;
  }

  for (let index = 1; index < polygon.rings.length; index += 1) {
    if (pointInRing(point, polygon.rings[index])) {
      return false;
    }
  }

  return true;
}

function projectWaterPolygon(
  feature: PolygonFeature,
  bbox: BBox,
  width: number,
  height: number,
): ProjectedWaterPolygon | null {
  const rings = feature.coordinates
    .map((ring) => ring.map((point) => projectToGrid(point, bbox, width, height)))
    .filter((ring) => ring.length >= 4);

  if (!rings.length) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const point of ring) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }

  return {
    rings,
    minX,
    maxX,
    minY,
    maxY,
  };
}

function cellInWaterArea(cell: GridCell, waterPolygons: ProjectedWaterPolygon[]): boolean {
  if (!waterPolygons.length) {
    return false;
  }

  const sample = {
    x: cell.x + 0.5,
    y: cell.y + 0.5,
  };

  return waterPolygons.some((polygon) => pointInProjectedWater(sample, polygon));
}

function waterCoverageRatio(cells: GridCell[], waterPolygons: ProjectedWaterPolygon[]): number {
  if (!cells.length || !waterPolygons.length) {
    return 0;
  }

  let covered = 0;
  for (const cell of cells) {
    if (cellInWaterArea(cell, waterPolygons)) {
      covered += 1;
    }
  }

  return covered / cells.length;
}

function rasterizeSegment(from: GridCell, to: GridCell): GridCell[] {
  const cells: GridCell[] = [];
  let currentX = from.x;
  let currentY = from.y;
  const deltaX = Math.abs(to.x - from.x);
  const deltaY = Math.abs(to.y - from.y);
  const stepX = from.x < to.x ? 1 : -1;
  const stepY = from.y < to.y ? 1 : -1;
  let error = deltaX - deltaY;

  while (true) {
    cells.push({ x: currentX, y: currentY });
    if (currentX === to.x && currentY === to.y) {
      break;
    }

    const doubledError = error * 2;
    if (doubledError > -deltaY) {
      error -= deltaY;
      currentX += stepX;
    }
    if (doubledError < deltaX) {
      error += deltaX;
      currentY += stepY;
    }
  }

  return cells;
}

function rasterizeProjectedLine(projected: GridPoint[]): GridCell[][] {
  const segments: GridCell[][] = [];

  for (let index = 1; index < projected.length; index += 1) {
    const from = snapToGrid(projected[index - 1]);
    const to = snapToGrid(projected[index]);
    if (from.x === to.x && from.y === to.y) {
      continue;
    }

    segments.push(rasterizeSegment(from, to));
  }

  return segments;
}

function flattenUniqueCells(segments: GridCell[][]): GridCell[] {
  const unique = new Map<string, GridCell>();

  for (const segment of segments) {
    for (const cell of segment) {
      unique.set(cellKey(cell), cell);
    }
  }

  return Array.from(unique.values());
}

function dedupeOrderedCells(cells: GridCell[]): GridCell[] {
  if (!cells.length) {
    return cells;
  }

  const deduped = [cells[0]];

  for (let index = 1; index < cells.length; index += 1) {
    const previous = deduped[deduped.length - 1];
    const current = cells[index];
    if (previous.x !== current.x || previous.y !== current.y) {
      deduped.push(current);
    }
  }

  return deduped;
}

function flattenCellPath(segments: GridCell[][]): GridCell[] {
  const path: GridCell[] = [];

  for (const segment of segments) {
    if (!segment.length) {
      continue;
    }

    if (!path.length) {
      path.push(...segment);
      continue;
    }

    const [first, ...rest] = segment;
    const previous = path[path.length - 1];
    if (previous.x === first.x && previous.y === first.y) {
      path.push(...rest);
    } else {
      path.push(...segment);
    }
  }

  return dedupeOrderedCells(path);
}

function coverageRatio(
  cells: GridCell[],
  occupied: Map<string, number>,
  minimumRank: number,
): number {
  if (!cells.length) {
    return 0;
  }

  let covered = 0;
  for (const cell of cells) {
    if ((occupied.get(cellKey(cell)) ?? Number.NEGATIVE_INFINITY) >= minimumRank) {
      covered += 1;
    }
  }

  return covered / cells.length;
}

function nearbyCoverageRatio(
  cells: GridCell[],
  occupied: Map<string, number>,
  minimumRank: number,
  radius: number,
): number {
  if (!cells.length) {
    return 0;
  }

  let covered = 0;

  for (const cell of cells) {
    let nearby = false;
    for (let offsetY = -radius; offsetY <= radius && !nearby; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if ((occupied.get(cellKey({ x: cell.x + offsetX, y: cell.y + offsetY })) ?? Number.NEGATIVE_INFINITY) >= minimumRank) {
          nearby = true;
          break;
        }
      }
    }

    if (nearby) {
      covered += 1;
    }
  }

  return covered / cells.length;
}

function cellHasNearbyCoverage(
  cell: GridCell,
  occupied: Map<string, number>,
  minimumRank: number,
  radius: number,
): boolean {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if ((occupied.get(cellKey({ x: cell.x + offsetX, y: cell.y + offsetY })) ?? Number.NEGATIVE_INFINITY) >= minimumRank) {
        return true;
      }
    }
  }

  return false;
}

function countNearbyNovelCells(
  cells: GridCell[],
  occupied: Map<string, number>,
  minimumRank: number,
  radius: number,
): number {
  let novel = 0;

  for (const cell of cells) {
    if (!cellHasNearbyCoverage(cell, occupied, minimumRank, radius)) {
      novel += 1;
    }
  }

  return novel;
}

function endpointConnectionCount(
  cells: GridCell[],
  occupied: Map<string, number>,
  minimumRank: number,
  radius: number,
): number {
  if (!cells.length) {
    return 0;
  }

  const endpoints = cells.length === 1 ? [cells[0]] : [cells[0], cells[cells.length - 1]];
  return endpoints.reduce(
    (count, cell) => count + (cellHasNearbyCoverage(cell, occupied, minimumRank, radius) ? 1 : 0),
    0,
  );
}

function addCellIndex(cellIndex: Map<string, number[]>, cell: GridCell, index: number): void {
  const key = cellKey(cell);
  const indexes = cellIndex.get(key);
  if (indexes) {
    indexes.push(index);
    return;
  }

  cellIndex.set(key, [index]);
}

function buildCellIndex(cellsByIndex: GridCell[][]): Map<string, number[]> {
  const cellIndex = new Map<string, number[]>();

  cellsByIndex.forEach((cells, index) => {
    for (const cell of cells) {
      addCellIndex(cellIndex, cell, index);
    }
  });

  return cellIndex;
}

function nearbyEndpointIndexes(
  cells: GridCell[],
  cellIndex: Map<string, number[]>,
  radius: number,
): Set<number> {
  const indexes = new Set<number>();
  const endpoints = cells.length === 1 ? [cells[0]] : [cells[0], cells[cells.length - 1]];
  const searchRadius = Math.ceil(radius);

  for (const endpoint of endpoints) {
    for (let y = endpoint.y - searchRadius; y <= endpoint.y + searchRadius; y += 1) {
      for (let x = endpoint.x - searchRadius; x <= endpoint.x + searchRadius; x += 1) {
        if (distance(endpoint, { x, y }) > radius) {
          continue;
        }

        const cellIndexes = cellIndex.get(cellKey({ x, y }));
        if (!cellIndexes) {
          continue;
        }

        for (const index of cellIndexes) {
          indexes.add(index);
        }
      }
    }
  }

  return indexes;
}

function endpointTouchesIndexedCells(
  cells: GridCell[],
  targetIndex: number,
  cellIndex: Map<string, number[]>,
  radius: number,
): boolean {
  const endpoints = cells.length === 1 ? [cells[0]] : [cells[0], cells[cells.length - 1]];
  const searchRadius = Math.ceil(radius);

  for (const endpoint of endpoints) {
    for (let y = endpoint.y - searchRadius; y <= endpoint.y + searchRadius; y += 1) {
      for (let x = endpoint.x - searchRadius; x <= endpoint.x + searchRadius; x += 1) {
        if (distance(endpoint, { x, y }) > radius) {
          continue;
        }

        const cellIndexes = cellIndex.get(cellKey({ x, y }));
        if (cellIndexes?.includes(targetIndex)) {
          return true;
        }
      }
    }
  }

  return false;
}

function lineRunsOutsideWaterAreas(
  coordinates: Position[],
  projected: GridPoint[],
  waterPolygons: ProjectedWaterPolygon[],
): Array<{ coordinates: Position[]; projected: GridPoint[] }> {
  if (!waterPolygons.length || coordinates.length < 2) {
    return [{ coordinates, projected }];
  }

  const runs: Array<{ coordinates: Position[]; projected: GridPoint[] }> = [];
  let currentCoordinates: Position[] = [];
  let currentProjected: GridPoint[] = [];

  for (let index = 1; index < coordinates.length; index += 1) {
    const from = snapToGrid(projected[index - 1]);
    const to = snapToGrid(projected[index]);
    const cells = from.x === to.x && from.y === to.y ? [from] : rasterizeSegment(from, to);
    const overWater = waterCoverageRatio(cells, waterPolygons) >= 0.45;

    if (overWater) {
      if (currentCoordinates.length >= 2) {
        runs.push({
          coordinates: currentCoordinates,
          projected: currentProjected,
        });
      }
      currentCoordinates = [];
      currentProjected = [];
      continue;
    }

    if (!currentCoordinates.length) {
      currentCoordinates.push(coordinates[index - 1]);
      currentProjected.push(projected[index - 1]);
    }

    currentCoordinates.push(coordinates[index]);
    currentProjected.push(projected[index]);
  }

  if (currentCoordinates.length >= 2) {
    runs.push({
      coordinates: currentCoordinates,
      projected: currentProjected,
    });
  }

  return runs;
}

function baseLineRank(kind: NonNullable<ReturnType<typeof classifyLine>>): number {
  switch (kind) {
    case 'primaryRoad':
      return 320;
    case 'rail':
      return 290;
    case 'stream':
      return 240;
    case 'secondaryRoad':
      return 210;
    case 'path':
      return 120;
    default:
      return 0;
  }
}

function roadDetailBonus(feature: LineFeature): number {
  const detail = (
    feature.tags.class ??
    feature.tags.subclass ??
    feature.tags.kind ??
    feature.tags.kind_detail ??
    feature.tags.highway ??
    feature.tags.railway ??
    ''
  ).toLowerCase();

  switch (detail) {
    case 'motorway':
      return 80;
    case 'trunk':
    case 'major_road':
      return 55;
    case 'primary':
      return 35;
    case 'secondary':
      return 22;
    case 'tertiary':
      return 12;
    case 'residential':
    case 'living_street':
      return 0;
    case 'service':
    case 'minor':
      return -18;
    case 'pedestrian':
    case 'steps':
    case 'track':
      return -24;
    case 'footway':
    case 'sidewalk':
    case 'crossing':
      return -40;
    case 'cycleway':
      return -18;
    case 'tram':
    case 'light_rail':
      return 20;
    default:
      return 0;
  }
}

function routeNetwork(feature: LineFeature): string {
  return (feature.tags.route_1_network ?? feature.tags.network ?? '').toLowerCase();
}

function routeReference(feature: LineFeature): string | undefined {
  return (
    feature.tags.route_1_ref ??
    feature.tags.ref ??
    feature.tags.shield_text ??
    feature.tags.shield_text_1 ??
    feature.tags.route_num
  );
}

function normalizeRouteRef(value: string): string {
  return value
    .toLowerCase()
    .replace(/^interstate\s+/, 'i ')
    .replace(/^state route\s+/, 'sr ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function routeContinuityKey(feature: LineFeature): string | null {
  const rawRef = routeReference(feature);
  const rawName = feature.name ?? feature.tags.name;
  const network = routeNetwork(feature);
  const ref = rawRef ? normalizeRouteRef(rawRef) : '';
  const compactRef = ref.replace(/\s+/g, '');

  if (compactRef && (network === 'us:i' || network === 'us-interstate' || /^i\d+$/.test(compactRef))) {
    return `interstate:${compactRef.replace(/^i/, '')}`;
  }

  if (compactRef && (network === 'us-state' || network.startsWith('us:'))) {
    return `route:${network}:${compactRef}`;
  }

  if (compactRef && !['usinterstate', 'usstate', 'road'].includes(compactRef)) {
    return `route:${compactRef}`;
  }

  if (rawName) {
    return `name:${normalizeRouteRef(rawName)}`;
  }

  return null;
}

function isInterstateRoute(feature: LineFeature): boolean {
  const network = routeNetwork(feature);
  const key = routeContinuityKey(feature);
  return network === 'us:i' || network === 'us-interstate' || Boolean(key?.startsWith('interstate:'));
}

function isMajorRouteNameLine(
  feature: LineFeature,
  kind: NonNullable<ReturnType<typeof classifyLine>>,
): boolean {
  if (feature.tags.source_layer !== 'transportation_name' || kind !== 'primaryRoad') {
    return false;
  }

  const detail = roadDetailTag(feature);
  return Boolean(routeReference(feature)) && ['motorway', 'trunk', 'primary'].includes(detail);
}

function linePriority(feature: LineFeature, kind: NonNullable<ReturnType<typeof classifyLine>>): number {
  let rank = baseLineRank(kind) + roadDetailBonus(feature);

  if (feature.name) {
    rank += 6;
  }

  if (routeContinuityKey(feature)) {
    rank += kind === 'primaryRoad' ? 18 : 8;
  }

  if (isInterstateRoute(feature)) {
    rank += 72;
  }

  if (feature.tags.service) {
    rank -= 16;
  }

  if (feature.tags.brunnel === 'tunnel' || feature.tags.tunnel === 'yes') {
    rank -= 18;
  }

  if (feature.tags.source_layer === 'transportation_name') {
    rank += isMajorRouteNameLine(feature, kind) ? 44 : -90;
  }

  return rank;
}

function headingVector(projected: GridPoint[]): GridPoint {
  if (projected.length < 2) {
    return { x: 0, y: 0 };
  }

  return {
    x: projected[projected.length - 1].x - projected[0].x,
    y: projected[projected.length - 1].y - projected[0].y,
  };
}

function normalizeVector(vector: GridPoint): GridPoint {
  const length = Math.hypot(vector.x, vector.y);
  if (length === 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function dot(left: GridPoint, right: GridPoint): number {
  return left.x * right.x + left.y * right.y;
}

function lineHeadingSimilarity(left: GridPoint[], right: GridPoint[]): number {
  const normalizedLeft = normalizeVector(headingVector(left));
  const normalizedRight = normalizeVector(headingVector(right));
  return dot(normalizedLeft, normalizedRight);
}

function uniqueCellsForCandidate(
  candidate: LineCandidate,
  candidateCells: Map<string, GridCell[]>,
  uniqueCellCache: Map<string, GridCell[]>,
): GridCell[] {
  const cached = uniqueCellCache.get(candidate.id);
  if (cached) {
    return cached;
  }

  const cells = candidateCells.get(candidate.id) ?? flattenCellPath(rasterizeProjectedLine(candidate.projected));
  const unique = Array.from(new Map(cells.map((cell) => [cellKey(cell), cell])).values());
  uniqueCellCache.set(candidate.id, unique);
  return unique;
}

function occupancyForCandidate(
  candidate: LineCandidate,
  candidateCells: Map<string, GridCell[]>,
  uniqueCellCache: Map<string, GridCell[]>,
  occupancyCache: Map<string, Map<string, number>>,
): Map<string, number> {
  const cached = occupancyCache.get(candidate.id);
  if (cached) {
    return cached;
  }

  const occupied = new Map<string, number>();
  updateOccupancy(uniqueCellsForCandidate(candidate, candidateCells, uniqueCellCache), occupied, candidate.rank);
  occupancyCache.set(candidate.id, occupied);
  return occupied;
}

function nearbyCoverageRatioForOccupiedCells(
  cells: GridCell[],
  occupied: Map<string, number>,
  minimumRank: number,
  radius: number,
): number {
  return nearbyCoverageRatio(cells, occupied, minimumRank, radius);
}

function cachedCorridorSimilarity(
  left: LineCandidate,
  right: LineCandidate,
  candidateCells: Map<string, GridCell[]>,
  uniqueCellCache: Map<string, GridCell[]>,
  occupancyCache: Map<string, Map<string, number>>,
  radius = 1,
): number {
  const leftCells = uniqueCellsForCandidate(left, candidateCells, uniqueCellCache);
  const rightCells = uniqueCellsForCandidate(right, candidateCells, uniqueCellCache);
  if (!leftCells.length || !rightCells.length) {
    return 0;
  }

  const leftCoverage = nearbyCoverageRatioForOccupiedCells(
    leftCells,
    occupancyForCandidate(right, candidateCells, uniqueCellCache, occupancyCache),
    right.rank - 40,
    radius,
  );
  const rightCoverage = nearbyCoverageRatioForOccupiedCells(
    rightCells,
    occupancyForCandidate(left, candidateCells, uniqueCellCache, occupancyCache),
    left.rank - 40,
    radius,
  );
  return Math.min(leftCoverage, rightCoverage);
}

function cachedCorridorCoverageRatio(
  candidate: LineCandidate,
  anchor: LineCandidate,
  candidateCells: Map<string, GridCell[]>,
  uniqueCellCache: Map<string, GridCell[]>,
  occupancyCache: Map<string, Map<string, number>>,
  radius = 1,
): number {
  const cells = uniqueCellsForCandidate(candidate, candidateCells, uniqueCellCache);
  if (!cells.length || !uniqueCellsForCandidate(anchor, candidateCells, uniqueCellCache).length) {
    return 0;
  }

  return nearbyCoverageRatioForOccupiedCells(
    cells,
    occupancyForCandidate(anchor, candidateCells, uniqueCellCache, occupancyCache),
    Number.NEGATIVE_INFINITY,
    radius,
  );
}

function addAnchorCellsToIndex(
  anchorCellIndex: Map<string, string[]>,
  anchor: LineCandidate,
  cells: GridCell[],
): void {
  for (const cell of cells) {
    const key = cellKey(cell);
    const anchors = anchorCellIndex.get(key);
    if (anchors) {
      anchors.push(anchor.id);
    } else {
      anchorCellIndex.set(key, [anchor.id]);
    }
  }
}

function nearbyAnchorIdsForCells(
  cells: GridCell[],
  anchorCellIndex: Map<string, string[]>,
  radius: number,
): Set<string> {
  const anchorIds = new Set<string>();
  const searchRadius = Math.ceil(radius);

  for (const cell of cells) {
    for (let y = cell.y - searchRadius; y <= cell.y + searchRadius; y += 1) {
      for (let x = cell.x - searchRadius; x <= cell.x + searchRadius; x += 1) {
        const nearbyAnchors = anchorCellIndex.get(cellKey({ x, y }));
        if (!nearbyAnchors) {
          continue;
        }

        for (const anchorId of nearbyAnchors) {
          anchorIds.add(anchorId);
        }
      }
    }
  }

  return anchorIds;
}

function isGraphRoadCandidate(candidate: LineCandidate): boolean {
  return candidate.kind === 'primaryRoad' || candidate.kind === 'secondaryRoad' || candidate.kind === 'rail';
}

function isCollapsibleRoadCandidate(candidate: LineCandidate): boolean {
  if (candidate.kind === 'primaryRoad' || candidate.kind === 'rail') {
    return true;
  }

  return candidate.kind === 'secondaryRoad' && candidate.rank >= 230 && !candidate.feature.tags.service;
}

function canShareRoadCenterline(left: LineCandidate, right: LineCandidate): boolean {
  return left.kind === right.kind && isCollapsibleRoadCandidate(left) && isCollapsibleRoadCandidate(right);
}

function isRoadLinkCandidate(candidate: LineCandidate): boolean {
  return roadDetailTag(candidate.feature).endsWith('_link');
}

function edgeKey(left: GridCell, right: GridCell): string {
  const leftKey = cellKey(left);
  const rightKey = cellKey(right);
  return leftKey < rightKey ? `${leftKey}|${rightKey}` : `${rightKey}|${leftKey}`;
}

function buildSnappedRoadGraph(candidates: LineCandidate[]): SnappedRoadGraph {
  const candidateCells = new Map<string, GridCell[]>();
  const neighbors = new Map<string, Set<string>>();
  const edges = new Set<string>();

  for (const candidate of candidates) {
    if (!isGraphRoadCandidate(candidate)) {
      continue;
    }

    const cells = flattenCellPath(rasterizeProjectedLine(candidate.projected));
    if (cells.length < 2) {
      continue;
    }

    candidateCells.set(candidate.id, cells);

    for (let index = 1; index < cells.length; index += 1) {
      const from = cells[index - 1];
      const to = cells[index];
      const key = edgeKey(from, to);
      if (edges.has(key)) {
        continue;
      }
      edges.add(key);

      const fromKey = cellKey(from);
      const toKey = cellKey(to);
      if (!neighbors.has(fromKey)) {
        neighbors.set(fromKey, new Set<string>());
      }
      if (!neighbors.has(toKey)) {
        neighbors.set(toKey, new Set<string>());
      }
      neighbors.get(fromKey)?.add(toKey);
      neighbors.get(toKey)?.add(fromKey);
    }
  }

  const nodeDegrees = new Map<string, number>();
  for (const [key, adjacent] of neighbors.entries()) {
    nodeDegrees.set(key, adjacent.size);
  }

  const primaryOccupancy = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'primaryRoad') {
      continue;
    }

    const cells = candidateCells.get(candidate.id);
    if (!cells) {
      continue;
    }

    updateOccupancy(cells, primaryOccupancy, candidate.rank);
  }

  const candidateStats = new Map<string, GraphCandidateStats>();
  const candidateImportance = new Map<string, number>();

  for (const candidate of candidates) {
    const cells = candidateCells.get(candidate.id);
    if (!cells || cells.length < 2) {
      continue;
    }

    const degrees = cells.map((cell) => nodeDegrees.get(cellKey(cell)) ?? 0);
    const startDegree = degrees[0] ?? 0;
    const endDegree = degrees[degrees.length - 1] ?? 0;
    const branchingEndpoints = Number(startDegree > 1) + Number(endDegree > 1);
    const junctionCount = degrees.filter((degree) => degree > 2).length;
    const maxDegree = degrees.reduce((maximum, degree) => Math.max(maximum, degree), 0);
    const touchesPrimary =
      candidate.kind !== 'primaryRoad' &&
      cells.some((cell) => cellHasNearbyCoverage(cell, primaryOccupancy, Number.NEGATIVE_INFINITY, 1));
    const importance =
      branchingEndpoints * 3 +
      junctionCount * 4 +
      Math.min(4, maxDegree) +
      (touchesPrimary ? 2 : 0) +
      Math.min(3, Math.floor(candidate.length / 12));

    candidateStats.set(candidate.id, {
      branchingEndpoints,
      junctionCount,
      maxDegree,
      importance,
      touchesPrimary,
    });
    candidateImportance.set(candidate.id, importance);
  }

  const duplicateAnchors = new Map<string, string>();
  const uniqueCellCache = new Map<string, GridCell[]>();
  const occupancyCache = new Map<string, Map<string, number>>();
  const anchorCellIndex = new Map<string, string[]>();
  const corridorAnchors = new Map<string, LineCandidate>();
  const addCorridorAnchor = (candidate: LineCandidate) => {
    corridorAnchors.set(candidate.id, candidate);
    addAnchorCellsToIndex(
      anchorCellIndex,
      candidate,
      uniqueCellsForCandidate(candidate, candidateCells, uniqueCellCache),
    );
  };
  const collapsibleCandidates = candidates
    .filter(isCollapsibleRoadCandidate)
    .sort((left, right) => {
      const rankDifference = right.rank - left.rank;
      if (rankDifference !== 0) {
        return rankDifference;
      }

      return right.length - left.length;
    });

  for (const candidate of collapsibleCandidates) {
    const candidateStatsEntry = candidateStats.get(candidate.id);
    if (!candidateStatsEntry) {
      addCorridorAnchor(candidate);
      continue;
    }

    let matchedAnchorId: string | null = null;
    const candidateUniqueCells = uniqueCellsForCandidate(candidate, candidateCells, uniqueCellCache);
    const nearbyAnchorIds = nearbyAnchorIdsForCells(
      candidateUniqueCells,
      anchorCellIndex,
      isRoadLinkCandidate(candidate) ? 3 : 2,
    );

    for (const anchorId of nearbyAnchorIds) {
      const anchor = corridorAnchors.get(anchorId);
      if (!anchor) {
        continue;
      }

      const anchorStats = candidateStats.get(anchor.id);
      if (!anchorStats || !canShareRoadCenterline(anchor, candidate)) {
        continue;
      }

      const headingSimilarity = Math.abs(lineHeadingSimilarity(anchor.projected, candidate.projected));
      const lengthRatio = Math.min(anchor.length, candidate.length) / Math.max(anchor.length, candidate.length);
      const importanceGap = anchorStats.importance - candidateStatsEntry.importance;
      const isRailPair = anchor.kind === 'rail' && candidate.kind === 'rail';
      const isRoadLinkPair = isRoadLinkCandidate(anchor) || isRoadLinkCandidate(candidate);
      const minimumHeadingSimilarity = isRailPair ? 0.68 : isRoadLinkPair ? 0.58 : 0.74;
      const minimumLengthRatio = isRailPair ? 0.25 : isRoadLinkPair ? 0.1 : 0.35;

      if (
        headingSimilarity < minimumHeadingSimilarity ||
        lengthRatio < minimumLengthRatio ||
        importanceGap < -1 ||
        candidateStatsEntry.junctionCount > anchorStats.junctionCount + (isRailPair || isRoadLinkPair ? 3 : 1) ||
        candidateStatsEntry.branchingEndpoints > anchorStats.branchingEndpoints + (isRailPair || isRoadLinkPair ? 3 : 1)
      ) {
        continue;
      }

      const similarity = cachedCorridorSimilarity(
        anchor,
        candidate,
        candidateCells,
        uniqueCellCache,
        occupancyCache,
        2,
      );
      const candidateCoverage = isRoadLinkPair
        ? cachedCorridorCoverageRatio(candidate, anchor, candidateCells, uniqueCellCache, occupancyCache, 2)
        : 0;

      if (
        similarity >= (isRailPair ? 0.48 : isRoadLinkPair ? 0.22 : 0.58) ||
        (isRoadLinkPair && candidateCoverage >= 0.42)
      ) {
        matchedAnchorId = anchor.id;
        break;
      }
    }

    if (matchedAnchorId) {
      duplicateAnchors.set(candidate.id, matchedAnchorId);
      continue;
    }

    addCorridorAnchor(candidate);
  }

  const candidateRoles = new Map<string, GraphRoadRole>();

  for (const candidate of candidates) {
    const stats = candidateStats.get(candidate.id);

    if (duplicateAnchors.has(candidate.id)) {
      candidateRoles.set(candidate.id, 'duplicate');
      continue;
    }

    if (candidate.kind === 'primaryRoad') {
      candidateRoles.set(candidate.id, 'corridor');
      continue;
    }

    if (candidate.kind === 'rail') {
      candidateRoles.set(candidate.id, stats && stats.importance >= 4 ? 'connector' : 'corridor');
      continue;
    }

    if (candidate.kind === 'secondaryRoad') {
      if (
        stats &&
        (stats.junctionCount >= 1 ||
          stats.branchingEndpoints >= 2 ||
          (stats.touchesPrimary && stats.importance >= 5))
      ) {
        candidateRoles.set(candidate.id, 'connector');
      } else {
        candidateRoles.set(candidate.id, 'local');
      }
      continue;
    }

    candidateRoles.set(candidate.id, 'local');
  }

  return {
    candidateCells,
    nodeDegrees,
    candidateRoles,
    candidateImportance,
    duplicateAnchors,
    candidateStats,
  };
}

function graphDegreesForCells(cells: GridCell[], graph: SnappedRoadGraph): number[] {
  return cells.map((cell) => graph.nodeDegrees.get(cellKey(cell)) ?? 0);
}

function isGraphConnector(candidate: LineCandidate, graph: SnappedRoadGraph): boolean {
  return graph.candidateRoles.get(candidate.id) === 'connector';
}

function collapseParallelRoadCorridors(
  candidates: LineCandidate[],
  graph: SnappedRoadGraph,
): { candidates: LineCandidate[]; collapsedCount: number } {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const clusters = new Map<string, LineCandidate[]>();
  const duplicateIds = new Set<string>();

  for (const [duplicateId, anchorId] of graph.duplicateAnchors) {
    const anchor = byId.get(anchorId);
    const duplicate = byId.get(duplicateId);
    if (!anchor || !duplicate) {
      continue;
    }

    duplicateIds.add(duplicateId);

    if (!clusters.has(anchorId)) {
      clusters.set(anchorId, [anchor]);
    }

    clusters.get(anchorId)?.push(duplicate);
  }

  const collapsed: LineCandidate[] = [];
  let collapsedCount = 0;

  for (const anchor of candidates) {
    if (duplicateIds.has(anchor.id)) {
      continue;
    }

    const cluster = clusters.get(anchor.id);
    if (!cluster) {
      collapsed.push(anchor);
      continue;
    }

    if (cluster.length === 1) {
      collapsed.push(anchor);
      continue;
    }

    collapsed.push({
      id: anchor.id,
      feature: anchor.feature,
      kind: anchor.kind,
      coordinates: anchor.coordinates,
      projected: anchor.projected,
      rank: Math.max(...cluster.map((candidate) => candidate.rank)) + cluster.length * 4,
      length: anchor.length,
    });

    for (const duplicate of cluster.slice(1)) {
      const stubResult = connectorStubCandidates(duplicate, anchor);
      if (stubResult.droppedSegments === 0) {
        collapsed.push(duplicate);
        continue;
      }

      collapsedCount += 1;
      collapsed.push(...stubResult.candidates);
    }
  }

  return {
    candidates: collapsed,
    collapsedCount,
  };
}

function anchorOccupancyForCandidate(anchor: LineCandidate): Map<string, number> {
  const occupied = new Map<string, number>();
  updateOccupancy(flattenUniqueCells(rasterizeProjectedLine(anchor.projected)), occupied, anchor.rank);
  return occupied;
}

function candidateRunSpansRenderedCells(projected: GridPoint[]): boolean {
  if (projected.length < 2) {
    return false;
  }

  const cells = flattenUniqueCells(rasterizeProjectedLine(projected));
  return cells.length >= 2;
}

function connectorStubCandidates(
  duplicate: LineCandidate,
  anchor: LineCandidate,
): { candidates: LineCandidate[]; droppedSegments: number } {
  const anchorOccupied = anchorOccupancyForCandidate(anchor);
  const coverageRadius = isRoadLinkCandidate(duplicate) || isRoadLinkCandidate(anchor) ? 2 : 1;
  const coverageThreshold = isRoadLinkCandidate(duplicate) || isRoadLinkCandidate(anchor) ? 0.42 : 0.62;
  const stubs: LineCandidate[] = [];
  let droppedSegments = 0;
  let currentCoordinates: Position[] = [];
  let currentProjected: GridPoint[] = [];

  const finishRun = () => {
    if (!candidateRunSpansRenderedCells(currentProjected)) {
      currentCoordinates = [];
      currentProjected = [];
      return;
    }

    const length = lineLength(currentProjected);
    if (length < 1) {
      currentCoordinates = [];
      currentProjected = [];
      return;
    }

    stubs.push({
      id: `${duplicate.id}:parallel-stub:${stubs.length}`,
      feature: duplicate.feature,
      kind: duplicate.kind,
      coordinates: currentCoordinates,
      projected: currentProjected,
      rank: duplicate.rank - 8,
      length,
    });
    currentCoordinates = [];
    currentProjected = [];
  };

  for (let index = 1; index < duplicate.projected.length; index += 1) {
    const from = snapToGrid(duplicate.projected[index - 1]);
    const to = snapToGrid(duplicate.projected[index]);
    if (from.x === to.x && from.y === to.y) {
      continue;
    }

    const segmentCells = rasterizeSegment(from, to);
    const coveredByAnchor =
      nearbyCoverageRatio(segmentCells, anchorOccupied, Number.NEGATIVE_INFINITY, coverageRadius) >= coverageThreshold;

    if (coveredByAnchor) {
      droppedSegments += 1;
      finishRun();
      continue;
    }

    if (!currentCoordinates.length) {
      currentCoordinates.push(duplicate.coordinates[index - 1]);
      currentProjected.push(duplicate.projected[index - 1]);
    }
    currentCoordinates.push(duplicate.coordinates[index]);
    currentProjected.push(duplicate.projected[index]);
  }

  finishRun();

  return { candidates: stubs, droppedSegments };
}

function isRoadLike(kind: NonNullable<ReturnType<typeof classifyLine>>): boolean {
  return kind === 'primaryRoad' || kind === 'secondaryRoad' || kind === 'path';
}

function roadNetworkDetail(value: number): number {
  if (Number.isNaN(value)) {
    return 18;
  }

  return clamp(value, 0, 100);
}

function roadSelectionProfile(width: number, height: number, detail: number): RoadSelectionProfile {
  const normalizedDetail = roadNetworkDetail(detail);
  const sizeScale = clamp(Math.sqrt(width * height) / Math.sqrt(96 * 72), 0.72, 1.65);
  const detailRatio = normalizedDetail / 100;
  const maxRoads = Math.round((8 + normalizedDetail * 0.34 + detailRatio * detailRatio * 190) * sizeScale);

  return {
    maxRoads,
    connectorReserve: Math.max(4, Math.round(maxRoads * (0.35 + detailRatio * 0.55))),
    aggregationRounds: Math.round(normalizedDetail / 16),
    minimumScore: 300 - normalizedDetail * 2.9,
  };
}

function roadConnectionRadius(detail: number): number {
  return roadNetworkDetail(detail) >= 80 ? 3 : 2;
}

function roadDetailTag(feature: LineFeature): string {
  return (
    feature.tags.class ??
    feature.tags.subclass ??
    feature.tags.kind ??
    feature.tags.kind_detail ??
    feature.tags.highway ??
    ''
  ).toLowerCase();
}

function roadCandidateScore(candidate: LineCandidate, graph: SnappedRoadGraph): number {
  const role = graph.candidateRoles.get(candidate.id) ?? 'local';
  const stats = graph.candidateStats.get(candidate.id);
  const detail = roadDetailTag(candidate.feature);
  const routeKey = routeContinuityKey(candidate.feature);
  let score =
    candidate.rank +
    Math.min(58, candidate.length * 2.1) +
    (stats?.importance ?? 0) * 8 +
    (candidate.feature.name ? 10 : 0);

  if (candidate.kind === 'primaryRoad') {
    score += 34;
  } else if (candidate.kind === 'secondaryRoad') {
    score += 4;
  } else if (candidate.kind === 'path') {
    score -= 12;
  }

  if (routeKey) {
    score += candidate.kind === 'primaryRoad' ? 22 : 8;
  }

  if (isInterstateRoute(candidate.feature)) {
    score += 88;
  } else if (routeNetwork(candidate.feature) === 'us-state') {
    score += 14;
  }

  if (isMajorRouteNameLine(candidate.feature, candidate.kind)) {
    score += 52;
  }

  if (role === 'corridor') {
    score += 24;
  } else if (role === 'connector') {
    score += 34;
  } else if (role === 'duplicate') {
    score -= 90;
  } else {
    score -= 18;
  }

  if (detail.endsWith('_link')) {
    score -= 24;
  }

  if (candidate.feature.tags.service) {
    score -= 38;
  }

  if (isExplicitSidewalk(candidate.feature)) {
    score -= 72;
  }

  if (candidate.feature.tags.brunnel === 'tunnel' || candidate.feature.tags.tunnel === 'yes') {
    score -= 18;
  }

  return score;
}

function cellsForCandidate(candidate: LineCandidate, graph: SnappedRoadGraph): GridCell[] {
  return graph.candidateCells.get(candidate.id) ?? flattenCellPath(rasterizeProjectedLine(candidate.projected));
}

function canUseRoadCandidate(candidate: LineCandidate, detail: number): boolean {
  const normalizedDetail = roadNetworkDetail(detail);
  if (candidate.kind === 'path') {
    return normalizedDetail >= 72;
  }

  if (
    normalizedDetail < 40 &&
    candidate.kind === 'primaryRoad' &&
    routeReference(candidate.feature) &&
    !isInterstateRoute(candidate.feature) &&
    roadDetailTag(candidate.feature) !== 'motorway' &&
    candidate.length < 24
  ) {
    return false;
  }

  return true;
}

function isRouteCenterlineCandidate(candidate: LineCandidate): boolean {
  return candidate.id.startsWith('route-centerline:');
}

function isRouteCenterlineFeature(feature: LineFeature): boolean {
  return feature.id.startsWith('route-centerline:');
}

function roadCandidateConnectionRadius(candidate: LineCandidate, detail: number): number {
  const baseRadius = roadConnectionRadius(detail);

  if (isRouteCenterlineCandidate(candidate) && isInterstateRoute(candidate.feature)) {
    return Math.max(baseRadius, 12);
  }

  if (isRouteCenterlineCandidate(candidate) || (routeReference(candidate.feature) && candidate.kind === 'primaryRoad')) {
    return Math.max(baseRadius, 7);
  }

  return baseRadius;
}

function isUnlabeledMajorRoadFragment(candidate: LineCandidate): boolean {
  if (candidate.kind !== 'primaryRoad' || isRouteCenterlineCandidate(candidate)) {
    return false;
  }

  const detail = roadDetailTag(candidate.feature);
  return (
    !routeReference(candidate.feature) &&
    !candidate.feature.name &&
    !candidate.feature.tags.name &&
    (detail === 'motorway' ||
      detail === 'trunk' ||
      detail === 'primary' ||
      detail === 'motorway_link' ||
      detail === 'trunk_link' ||
      detail === 'primary_link')
  );
}

function roadCandidateLooksLikeSelectedRouteFragment(
  candidate: LineCandidate,
  graph: SnappedRoadGraph,
  selectedRoadCells: Map<string, number>,
  selectedRouteCenterlineCells: Map<string, number>,
  detail: number,
): boolean {
  const normalizedDetail = roadNetworkDetail(detail);
  if (!selectedRouteCenterlineCells.size || !isUnlabeledMajorRoadFragment(candidate)) {
    return false;
  }

  const cells = cellsForCandidate(candidate, graph);
  if (!cells.length) {
    return false;
  }

  const role = graph.candidateRoles.get(candidate.id);
  const stats = graph.candidateStats.get(candidate.id);
  const radius = normalizedDetail >= 50 ? 3 : 5;
  const nearbyCoverage = nearbyCoverageRatio(cells, selectedRouteCenterlineCells, Number.NEGATIVE_INFINITY, radius);
  const duplicateThreshold = normalizedDetail >= 88 ? 0.42 : normalizedDetail >= 50 ? 0.24 : 0.1;
  if (nearbyCoverage < duplicateThreshold) {
    return false;
  }

  const endpointNetworkConnections = endpointConnectionCount(
    cells,
    selectedRoadCells,
    Number.NEGATIVE_INFINITY,
    roadConnectionRadius(detail),
  );
  const endpointRouteConnections = endpointConnectionCount(
    cells,
    selectedRouteCenterlineCells,
    Number.NEGATIVE_INFINITY,
    radius,
  );
  const connectorLike =
    role === 'connector' ||
    Boolean(stats && (stats.branchingEndpoints >= 2 || stats.junctionCount >= 1 || stats.importance >= 7));
  const bridgesAwayFromRoute =
    connectorLike && endpointNetworkConnections >= 2 && endpointRouteConnections <= 1 && nearbyCoverage < 0.58;

  return !bridgesAwayFromRoute;
}

function roadCandidateTouchesNetwork(
  candidate: LineCandidate,
  graph: SnappedRoadGraph,
  selectedRoadCells: Map<string, number>,
  radius: number,
): boolean {
  const cells = cellsForCandidate(candidate, graph);
  if (!cells.length) {
    return false;
  }

  return endpointConnectionCount(cells, selectedRoadCells, Number.NEGATIVE_INFINITY, radius) > 0;
}

function roadCandidateContinuesSelectedRoute(
  candidate: LineCandidate,
  graph: SnappedRoadGraph,
  selectedRoadCells: Map<string, number>,
  selectedRouteKeys: Set<string>,
): boolean {
  const key = routeContinuityKey(candidate.feature);
  if (!key || !selectedRouteKeys.has(key)) {
    return false;
  }

  const cells = cellsForCandidate(candidate, graph);
  return endpointConnectionCount(cells, selectedRoadCells, Number.NEGATIVE_INFINITY, 7) > 0;
}

function incrementCellCounts(cells: GridCell[], counts: Map<string, number>): void {
  for (const cell of cells) {
    const key = cellKey(cell);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

function buildSelectedRoadCellCounts(
  candidates: LineCandidate[],
  selectedIds: Set<string>,
  graph: SnappedRoadGraph,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.id) || !isRoadLike(candidate.kind)) {
      continue;
    }

    incrementCellCounts(cellsForCandidate(candidate, graph), counts);
  }

  return counts;
}

function nearestOtherSelectedCell(
  endpoint: GridCell,
  selectedCellCounts: Map<string, number>,
  ownCellCounts: Map<string, number>,
  radius: number,
): GridCell | null {
  let best: { cell: GridCell; distance: number } | null = null;
  const searchRadius = Math.ceil(radius);

  for (let y = endpoint.y - searchRadius; y <= endpoint.y + searchRadius; y += 1) {
    for (let x = endpoint.x - searchRadius; x <= endpoint.x + searchRadius; x += 1) {
      const candidate = { x, y };
      const candidateDistance = distance(endpoint, candidate);
      if (candidateDistance > radius) {
        continue;
      }

      const key = cellKey(candidate);
      const otherCount = (selectedCellCounts.get(key) ?? 0) - (ownCellCounts.get(key) ?? 0);
      if (otherCount <= 0) {
        continue;
      }

      if (!best || candidateDistance < best.distance) {
        best = {
          cell: candidate,
          distance: candidateDistance,
        };
      }
    }
  }

  return best?.cell ?? null;
}

function endpointCanSnapToNetwork(candidate: LineCandidate, endpoint: GridCell, width: number, height: number): boolean {
  if (!isRouteCenterlineCandidate(candidate)) {
    return true;
  }

  return endpoint.x > 1 && endpoint.x < width - 1 && endpoint.y > 1 && endpoint.y < height - 1;
}

function snapSelectedRoadEndpointsToNetwork(
  candidate: LineCandidate,
  graph: SnappedRoadGraph,
  selectedCellCounts: Map<string, number>,
  bbox: BBox,
  width: number,
  height: number,
  detail: number,
): Pick<LineCandidate, 'coordinates' | 'projected'> {
  if (candidate.projected.length < 2) {
    return {
      coordinates: candidate.coordinates,
      projected: candidate.projected,
    };
  }

  const candidateCells = cellsForCandidate(candidate, graph);
  const ownCellCounts = new Map<string, number>();
  incrementCellCounts(candidateCells, ownCellCounts);

  const radius = roadCandidateConnectionRadius(candidate, detail);
  const projected = candidate.projected.map((point) => ({ ...point }));
  let changed = false;
  const startEndpoint = snapToGrid(projected[0]);

  const startTarget = endpointCanSnapToNetwork(candidate, startEndpoint, width, height)
    ? nearestOtherSelectedCell(startEndpoint, selectedCellCounts, ownCellCounts, radius)
    : null;
  if (startTarget) {
    projected[0] = startTarget;
    changed = true;
  }

  const endIndex = projected.length - 1;
  const endEndpoint = snapToGrid(projected[endIndex]);
  const endTarget = endpointCanSnapToNetwork(candidate, endEndpoint, width, height)
    ? nearestOtherSelectedCell(endEndpoint, selectedCellCounts, ownCellCounts, radius)
    : null;
  if (endTarget) {
    projected[endIndex] = endTarget;
    changed = true;
  }

  if (!changed) {
    return {
      coordinates: candidate.coordinates,
      projected: candidate.projected,
    };
  }

  return {
    coordinates: projected.map((point) => unprojectFromGrid(point, bbox, width, height)),
    projected,
  };
}

function pruneDisconnectedRoadSelection(
  selectedIds: Set<string>,
  scored: Array<{ candidate: LineCandidate; score: number }>,
  graph: SnappedRoadGraph,
  detail: number,
): void {
  if (selectedIds.size < 2) {
    return;
  }

  const selected = scored.filter(({ candidate }) => selectedIds.has(candidate.id));
  const parent = selected.map((_, index) => index);
  const cellsByIndex = selected.map(({ candidate }) => cellsForCandidate(candidate, graph));
  const cellIndex = buildCellIndex(cellsByIndex);
  const routeKeys = selected.map(({ candidate }) => routeContinuityKey(candidate.feature));
  const connectionRadius = roadConnectionRadius(detail);
  const maxConnectionRadius = Math.max(connectionRadius, 12);

  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }

    return index;
  };

  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let left = 0; left < selected.length; left += 1) {
    for (const right of nearbyEndpointIndexes(cellsByIndex[left], cellIndex, maxConnectionRadius)) {
      if (right === left) {
        continue;
      }

      const sameRoute = Boolean(routeKeys[left] && routeKeys[left] === routeKeys[right]);
      const routeBridge =
        (isRouteCenterlineCandidate(selected[left].candidate) || isRouteCenterlineCandidate(selected[right].candidate)) &&
        (isInterstateRoute(selected[left].candidate.feature) || isInterstateRoute(selected[right].candidate.feature));
      const radius = sameRoute ? Math.max(connectionRadius, 7) : routeBridge ? 12 : connectionRadius;

      if (endpointTouchesIndexedCells(cellsByIndex[left], right, cellIndex, radius)) {
        union(left, right);
      }
    }
  }

  const groups = new Map<
    number,
    {
      score: number;
      length: number;
      count: number;
      hasInterstate: boolean;
      hasRouteReference: boolean;
      hasNamedRoute: boolean;
    }
  >();

  selected.forEach(({ candidate, score }, index) => {
    const root = find(index);
    const previous = groups.get(root) ?? {
      score: 0,
      length: 0,
      count: 0,
      hasInterstate: false,
      hasRouteReference: false,
      hasNamedRoute: false,
    };
    const routeKey = routeContinuityKey(candidate.feature);

    groups.set(root, {
      score: previous.score + score,
      length: previous.length + candidate.length,
      count: previous.count + 1,
      hasInterstate: previous.hasInterstate || isInterstateRoute(candidate.feature),
      hasRouteReference: previous.hasRouteReference || Boolean(routeReference(candidate.feature)),
      hasNamedRoute: previous.hasNamedRoute || Boolean(routeKey?.startsWith('name:')),
    });
  });

  let keepRoot: number | null = null;
  let keepScore = Number.NEGATIVE_INFINITY;

  for (const [root, group] of groups.entries()) {
    const componentScore =
      group.score + group.length * 0.5 + group.count * 12 + (group.hasInterstate ? 100_000 : 0);
    if (componentScore > keepScore) {
      keepScore = componentScore;
      keepRoot = root;
    }
  }

  if (keepRoot === null || groups.size < 2) {
    return;
  }

  const keepRoots = new Set<number>([keepRoot]);

  selected.forEach(({ candidate }, index) => {
    if (!keepRoots.has(find(index))) {
      selectedIds.delete(candidate.id);
    }
  });
}

function pruneCuratedDisconnectedRoads(
  curated: MapFeature[],
  bbox: BBox,
  width: number,
  height: number,
): number {
  const roads = curated
    .map((feature, index) => {
      if (feature.type !== 'line') {
        return null;
      }

      const kind = classifyLine(feature);
      if (!kind || !isRoadLike(kind)) {
        return null;
      }

      const projected = feature.coordinates.map((point) => projectToGrid(point, bbox, width, height));
      const cells = flattenCellPath(rasterizeProjectedLine(projected));
      if (cells.length < 2) {
        return null;
      }

      return {
        feature,
        index,
        kind,
        cells,
        length: lineLength(projected),
        routeKey: routeContinuityKey(feature),
        score: linePriority(feature, kind) + lineLength(projected),
        hasInterstate: isInterstateRoute(feature),
        hasRouteReference: Boolean(routeReference(feature)),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (roads.length < 2) {
    return 0;
  }

  const parent = roads.map((_, index) => index);
  const cellIndex = buildCellIndex(roads.map((road) => road.cells));
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }

    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let left = 0; left < roads.length; left += 1) {
    for (const right of nearbyEndpointIndexes(roads[left].cells, cellIndex, 12)) {
      if (right === left) {
        continue;
      }

      const sameRoute = Boolean(roads[left].routeKey && roads[left].routeKey === roads[right].routeKey);
      const routeBridge =
        (isRouteCenterlineFeature(roads[left].feature) || isRouteCenterlineFeature(roads[right].feature)) &&
        (roads[left].hasInterstate || roads[right].hasInterstate);
      const radius = sameRoute ? 7 : routeBridge ? 12 : 2;

      if (endpointTouchesIndexedCells(roads[left].cells, right, cellIndex, radius)) {
        union(left, right);
      }
    }
  }

  const groups = new Map<
    number,
    {
      count: number;
      score: number;
      length: number;
      hasInterstate: boolean;
      hasRouteReference: boolean;
      hasNamedRoute: boolean;
    }
  >();

  roads.forEach((road, index) => {
    const root = find(index);
    const previous = groups.get(root) ?? {
      count: 0,
      score: 0,
      length: 0,
      hasInterstate: false,
      hasRouteReference: false,
      hasNamedRoute: false,
    };

    groups.set(root, {
      count: previous.count + 1,
      score: previous.score + road.score,
      length: previous.length + road.length,
      hasInterstate: previous.hasInterstate || road.hasInterstate,
      hasRouteReference: previous.hasRouteReference || road.hasRouteReference,
      hasNamedRoute: previous.hasNamedRoute || Boolean(road.routeKey?.startsWith('name:')),
    });
  });

  if (groups.size < 2) {
    return 0;
  }

  let keepRoot: number | null = null;
  let keepScore = Number.NEGATIVE_INFINITY;
  for (const [root, group] of groups.entries()) {
    const score = group.score + group.count * 16 + (group.hasInterstate ? 100_000 : 0);
    if (score > keepScore) {
      keepRoot = root;
      keepScore = score;
    }
  }

  if (keepRoot === null) {
    return 0;
  }

  const keepRoots = new Set<number>([keepRoot]);

  const droppedIndices = new Set<number>();
  roads.forEach((road, index) => {
    if (!keepRoots.has(find(index))) {
      droppedIndices.add(road.index);
    }
  });

  for (let index = curated.length - 1; index >= 0; index -= 1) {
    if (droppedIndices.has(index)) {
      curated.splice(index, 1);
    }
  }

  return droppedIndices.size;
}

function selectRoadNetworkCandidates(
  candidates: LineCandidate[],
  graph: SnappedRoadGraph,
  width: number,
  height: number,
  detail: number,
): RoadSelectionResult {
  const profile = roadSelectionProfile(width, height, detail);
  const normalizedDetail = roadNetworkDetail(detail);
  const connectionRadius = roadConnectionRadius(detail);
  const selectedIds = new Set<string>();
  const selectedRoadCells = new Map<string, number>();
  const selectedRouteCenterlineCells = new Map<string, number>();
  const selectedRouteKeys = new Set<string>();
  const scored = candidates
    .filter((candidate) => isRoadLike(candidate.kind))
    .map((candidate) => ({
      candidate,
      score: roadCandidateScore(candidate, graph),
    }))
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return right.candidate.length - left.candidate.length;
    });

  const addCandidate = (candidate: LineCandidate, score: number) => {
    selectedIds.add(candidate.id);
    const cells = cellsForCandidate(candidate, graph);
    updateOccupancy(cells, selectedRoadCells, score);
    if (isRouteCenterlineCandidate(candidate)) {
      updateOccupancy(cells, selectedRouteCenterlineCells, score);
    }
    const routeKey = routeContinuityKey(candidate.feature);
    if (routeKey) {
      selectedRouteKeys.add(routeKey);
    }
  };

  const networkGrowthScore = ({ candidate, score }: { candidate: LineCandidate; score: number }) => {
    const routeKey = routeContinuityKey(candidate.feature);
    return score + (routeKey && selectedRouteKeys.has(routeKey) ? 70 : 0);
  };

  const seed = scored.find(({ candidate, score }) => score >= profile.minimumScore && canUseRoadCandidate(candidate, detail));
  if (seed) {
    addCandidate(seed.candidate, seed.score);
  }

  while (selectedIds.size < profile.maxRoads) {
    let next: { candidate: LineCandidate; score: number } | null = null;

    for (const entry of scored) {
      const { candidate, score } = entry;
      if (
        selectedIds.has(candidate.id) ||
        score < profile.minimumScore ||
        !canUseRoadCandidate(candidate, detail) ||
        roadCandidateLooksLikeSelectedRouteFragment(candidate, graph, selectedRoadCells, selectedRouteCenterlineCells, detail) ||
        (!roadCandidateTouchesNetwork(candidate, graph, selectedRoadCells, roadCandidateConnectionRadius(candidate, detail)) &&
          !roadCandidateContinuesSelectedRoute(candidate, graph, selectedRoadCells, selectedRouteKeys))
      ) {
        continue;
      }

      if (!next || networkGrowthScore(entry) > networkGrowthScore(next)) {
        next = entry;
      }
    }

    if (!next) {
      break;
    }

    addCandidate(next.candidate, next.score);
  }

  if (!selectedIds.size) {
    return {
      selectedIds,
      droppedBudget: scored.length,
    };
  }

  const connectorLimit = profile.maxRoads + profile.connectorReserve;
  const perRoundLimit =
    profile.aggregationRounds > 0 ? Math.max(1, Math.ceil(profile.connectorReserve / profile.aggregationRounds)) : 0;

  for (let round = 0; round < profile.aggregationRounds && selectedIds.size < connectorLimit; round += 1) {
    const roundBaseRoadCells = new Map(selectedRoadCells);
    let addedThisRound = 0;

    for (const { candidate, score } of scored) {
      if (selectedIds.size >= connectorLimit || addedThisRound >= perRoundLimit) {
        break;
      }

      if (
        selectedIds.has(candidate.id) ||
        (candidate.kind === 'path' && normalizedDetail < 82) ||
        roadCandidateLooksLikeSelectedRouteFragment(candidate, graph, selectedRoadCells, selectedRouteCenterlineCells, detail)
      ) {
        continue;
      }

      const role = graph.candidateRoles.get(candidate.id) ?? 'local';
      const stats = graph.candidateStats.get(candidate.id);
      if (normalizedDetail < 88 && role !== 'connector' && (stats?.importance ?? 0) < 7) {
        continue;
      }

      if (score < profile.minimumScore - (normalizedDetail >= 88 ? 130 : 46)) {
        continue;
      }

      const cells = cellsForCandidate(candidate, graph);
      if (!cells.length) {
        continue;
      }

      const endpointConnections = endpointConnectionCount(
        cells,
        roundBaseRoadCells,
        Number.NEGATIVE_INFINITY,
        roadCandidateConnectionRadius(candidate, detail),
      );
      const routeContinuation = roadCandidateContinuesSelectedRoute(
        candidate,
        graph,
        roundBaseRoadCells,
        selectedRouteKeys,
      );
      const novelCellCount = countNearbyNovelCells(cells, selectedRoadCells, Number.NEGATIVE_INFINITY, 1);
      const minimumNovelCells = Math.max(2, Math.floor(cells.length * 0.08));

      if (novelCellCount >= minimumNovelCells && (endpointConnections > 0 || routeContinuation)) {
        addCandidate(candidate, score);
        addedThisRound += 1;
      }
    }

    if (addedThisRound === 0) {
      break;
    }
  }

  pruneDisconnectedRoadSelection(selectedIds, scored, graph, detail);

  return {
    selectedIds,
    droppedBudget: scored.length - selectedIds.size,
  };
}

function isExplicitSidewalk(feature: LineFeature): boolean {
  const detail = (
    feature.tags.subclass ??
    feature.tags.class ??
    feature.tags.footway ??
    feature.tags.highway ??
    ''
  ).toLowerCase();

  return detail.includes('sidewalk') || detail === 'footway' || detail === 'crossing';
}

function updateOccupancy(cells: GridCell[], occupied: Map<string, number>, rank: number): void {
  for (const cell of cells) {
    const key = cellKey(cell);
    occupied.set(key, Math.max(occupied.get(key) ?? Number.NEGATIVE_INFINITY, rank));
  }
}

function shouldKeepContinuousCandidate(candidate: LineCandidate, occupiedKind: Map<string, number>): boolean {
  const cells = flattenUniqueCells(rasterizeProjectedLine(candidate.projected));
  if (!cells.length) {
    return false;
  }

  const nearbyThreshold = candidate.rank - 20;
  const nearbyCoverage = nearbyCoverageRatio(cells, occupiedKind, nearbyThreshold, 1);
  const exactCoverage = coverageRatio(cells, occupiedKind, candidate.rank);
  const novelCellCount = countNearbyNovelCells(cells, occupiedKind, nearbyThreshold, 1);
  const minimumNovelCells = Math.max(3, Math.floor(cells.length * 0.08));

  if (nearbyCoverage >= 0.94 && novelCellCount <= minimumNovelCells) {
    return false;
  }

  if (exactCoverage >= 0.84 && nearbyCoverage >= 0.88 && novelCellCount <= minimumNovelCells + 1) {
    return false;
  }

  return true;
}

function continuousLineKind(candidate: LineCandidate): candidate is LineCandidate & { kind: 'rail' | 'stream' } {
  return candidate.kind === 'rail' || candidate.kind === 'stream';
}

function selectContinuousLineCandidates(candidates: LineCandidate[]): Set<string> {
  const selected = new Set<string>();
  const occupancy = new Map<'rail' | 'stream', Map<string, number>>([
    ['rail', new Map<string, number>()],
    ['stream', new Map<string, number>()],
  ]);

  for (const candidate of candidates) {
    if (!continuousLineKind(candidate)) {
      continue;
    }

    const occupiedKind = occupancy.get(candidate.kind)!;
    if (!shouldKeepContinuousCandidate(candidate, occupiedKind)) {
      continue;
    }

    selected.add(candidate.id);
    updateOccupancy(flattenUniqueCells(rasterizeProjectedLine(candidate.projected)), occupiedKind, candidate.rank);
  }

  return selected;
}

function buildContinuousLineCellCounts(
  candidates: LineCandidate[],
  selectedIds: Set<string>,
): Map<'rail' | 'stream', Map<string, number>> {
  const counts = new Map<'rail' | 'stream', Map<string, number>>([
    ['rail', new Map<string, number>()],
    ['stream', new Map<string, number>()],
  ]);

  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.id) || !continuousLineKind(candidate)) {
      continue;
    }
    incrementCellCounts(flattenUniqueCells(rasterizeProjectedLine(candidate.projected)), counts.get(candidate.kind)!);
  }

  return counts;
}

function snapContinuousLineEndpoints(
  candidate: LineCandidate & { kind: 'rail' | 'stream' },
  selectedCellCounts: Map<string, number>,
  bbox: BBox,
  width: number,
  height: number,
): Pick<LineCandidate, 'coordinates' | 'projected'> {
  const projected = candidate.projected.map((point) => ({ ...point }));
  const ownCellCounts = new Map<string, number>();
  incrementCellCounts(flattenUniqueCells(rasterizeProjectedLine(projected)), ownCellCounts);
  const radius = candidate.kind === 'rail' ? 2 : 1.5;
  let changed = false;

  for (const index of [0, projected.length - 1]) {
    const endpoint = snapToGrid(projected[index]);
    const isViewportEdge = endpoint.x <= 1 || endpoint.x >= width - 1 || endpoint.y <= 1 || endpoint.y >= height - 1;
    if (isViewportEdge) {
      continue;
    }
    const target = nearestOtherSelectedCell(endpoint, selectedCellCounts, ownCellCounts, radius);
    if (target) {
      projected[index] = target;
      changed = true;
    }
  }

  return changed
    ? {
        coordinates: projected.map((point) => unprojectFromGrid(point, bbox, width, height)),
        projected,
      }
    : { coordinates: candidate.coordinates, projected: candidate.projected };
}

function thinLineCandidate(
  candidate: LineCandidate,
  occupiedLines: Map<string, number>,
  occupiedRoads: Map<string, number>,
): {
  keptRuns: Position[][];
  keptCells: GridCell[][];
  overlapDropped: number;
  adjacentDropped: number;
} {
  const keptRuns: Position[][] = [];
  const keptCells: GridCell[][] = [];
  let currentRun: Position[] = [];
  let overlapDropped = 0;
  let adjacentDropped = 0;

  for (let index = 1; index < candidate.coordinates.length; index += 1) {
    const from = snapToGrid(candidate.projected[index - 1]);
    const to = snapToGrid(candidate.projected[index]);
    if (from.x === to.x && from.y === to.y) {
      continue;
    }

    const cells = rasterizeSegment(from, to);
    const exactLineCoverage = coverageRatio(cells, occupiedLines, candidate.rank);
    const nearbyLineCoverage = nearbyCoverageRatio(cells, occupiedLines, candidate.rank, 1);
    const nearbyRoadCoverage = nearbyCoverageRatio(cells, occupiedRoads, candidate.kind === 'path' ? 180 : candidate.rank, 1);

    let dropReason: 'overlap' | 'adjacent' | null = null;

    if (candidate.kind === 'path') {
      const sidewalkThreshold = isExplicitSidewalk(candidate.feature) ? 0.56 : 0.74;
      if (nearbyRoadCoverage >= sidewalkThreshold) {
        dropReason = 'adjacent';
      } else if (exactLineCoverage >= 0.58 || nearbyLineCoverage >= 0.9) {
        dropReason = 'overlap';
      }
    } else if (candidate.kind === 'secondaryRoad') {
      if (exactLineCoverage >= 0.72 || (nearbyRoadCoverage >= 0.82 && exactLineCoverage >= 0.2)) {
        dropReason = 'overlap';
      }
    } else if (candidate.kind === 'primaryRoad') {
      if (exactLineCoverage >= 0.78 || (nearbyRoadCoverage >= 0.88 && exactLineCoverage >= 0.16)) {
        dropReason = 'overlap';
      }
    } else if (exactLineCoverage >= 0.82 || nearbyLineCoverage >= 0.94) {
      dropReason = 'overlap';
    }

    if (dropReason) {
      if (currentRun.length >= 2) {
        keptRuns.push(currentRun);
      }
      currentRun = [];
      if (dropReason === 'adjacent') {
        adjacentDropped += 1;
      } else {
        overlapDropped += 1;
      }
      continue;
    }

    if (!currentRun.length) {
      currentRun.push(candidate.coordinates[index - 1]);
    }
    currentRun.push(candidate.coordinates[index]);
    keptCells.push(cells);
  }

  if (currentRun.length >= 2) {
    keptRuns.push(currentRun);
  }

  return {
    keptRuns,
    keptCells,
    overlapDropped,
    adjacentDropped,
  };
}

function markerPriority(feature: PointFeature): number {
  const kind = classifyMarker(feature);
  switch (kind) {
    case 'hospital':
      return 5;
    case 'station':
      return 4;
    case 'viewpoint':
      return 3;
    case 'museum':
      return 2;
    case 'cafe':
      return 1;
    default:
      return 0;
  }
}

function markerCellKey(position: GridPoint): string {
  return `${Math.floor(position.x)}:${Math.floor(position.y)}`;
}

export function curateFeatures(
  features: MapFeature[],
  options: CurateFeaturesOptions,
): CurateFeaturesResult {
  const profile = detailProfiles[options.detailLevel];
  const useSourceZoomRoadNetwork = options.roadNetworkMode === 'sourceZoom';
  const curated: MapFeature[] = [];
  const stats: CurateFeaturesStats = {
    originalCount: features.length,
    curatedCount: 0,
    polygonsKept: 0,
    linesKept: 0,
    markersKept: 0,
    droppedUnclassified: 0,
    droppedSmallPolygons: 0,
    droppedShortLines: 0,
    droppedOverlappingLines: 0,
    droppedAdjacentPaths: 0,
    droppedRoadBudget: 0,
    roadsCollapsed: 0,
    droppedCrowdedMarkers: 0,
    droppedMarkerBudget: 0,
  };

  const polygons = features.filter((feature): feature is PolygonFeature => feature.type === 'polygon');
  const lines = features.filter((feature): feature is LineFeature => feature.type === 'line');
  const points = features.filter((feature): feature is PointFeature => feature.type === 'point');
  const waterPolygons: ProjectedWaterPolygon[] = [];

  for (const polygon of polygons) {
    const style = classifyPolygon(polygon);
    if (!style) {
      stats.droppedUnclassified += 1;
      continue;
    }

    const areaInCells = polygonAreaInCells(polygon, options.bbox, options.width, options.height);
    const minArea = polygon.tags.building ? profile.minBuildingAreaCells : profile.minLandAreaCells;
    if (areaInCells < minArea) {
      stats.droppedSmallPolygons += 1;
      continue;
    }

    curated.push(polygon);
    stats.polygonsKept += 1;

    if (style.id === 'water') {
      const waterPolygon = projectWaterPolygon(polygon, options.bbox, options.width, options.height);
      if (waterPolygon) {
        waterPolygons.push(waterPolygon);
      }
    }
  }

  const lineCandidates: LineCandidate[] = [];

  for (const line of lines) {
    const kind = classifyLine(line);
    if (!kind) {
      stats.droppedUnclassified += 1;
      continue;
    }

    if (line.tags.source_layer === 'transportation_name' && !isMajorRouteNameLine(line, kind)) {
      stats.droppedOverlappingLines += 1;
      continue;
    }

    if (!options.includeMinorRoads && (kind === 'secondaryRoad' || kind === 'path')) {
      stats.droppedShortLines += 1;
      continue;
    }

    const useSourceGeometry = useSourceZoomRoadNetwork && isRoadLike(kind);
    const simplifiedCoordinates = useSourceGeometry
      ? line.coordinates
      : simplifyCoordinates(
          line.coordinates,
          options.bbox,
          options.width,
          options.height,
          profile.simplifyTolerance,
        );
    if (simplifiedCoordinates.length < 2) {
      stats.droppedShortLines += 1;
      continue;
    }

    const projected = simplifiedCoordinates.map((point) => projectToGrid(point, options.bbox, options.width, options.height));
    if (lineLength(projected) < profile.minLineLengthCells) {
      stats.droppedShortLines += 1;
      continue;
    }

    const runs =
      kind === 'stream'
        ? lineRunsOutsideWaterAreas(simplifiedCoordinates, projected, waterPolygons)
        : [{ coordinates: simplifiedCoordinates, projected }];

    if (!runs.length) {
      stats.droppedOverlappingLines += 1;
      continue;
    }

    runs.forEach((run, index) => {
      const runLength = lineLength(run.projected);
      if (runLength < profile.minLineLengthCells) {
        stats.droppedShortLines += 1;
        return;
      }

      lineCandidates.push({
        id: runs.length === 1 ? line.id : `${line.id}:water:${index}`,
        feature: line,
        kind,
        coordinates: run.coordinates,
        projected: run.projected,
        rank: linePriority(line, kind),
        length: runLength,
      });
    });
  }

  const initialRoadGraph = buildSnappedRoadGraph(lineCandidates);
  const collapsedRoads = collapseParallelRoadCorridors(lineCandidates, initialRoadGraph);
  const collapsedLineCandidates = collapsedRoads.candidates;
  const roadGraph = buildSnappedRoadGraph(collapsedLineCandidates);
  const roadSelection = useSourceZoomRoadNetwork
    ? {
        selectedIds: new Set(
          collapsedLineCandidates
            .filter((candidate) => isRoadLike(candidate.kind))
            .map((candidate) => candidate.id),
        ),
        droppedBudget: 0,
      }
    : selectRoadNetworkCandidates(
        collapsedLineCandidates,
        roadGraph,
        options.width,
        options.height,
        options.roadNetworkDetail,
      );
  stats.roadsCollapsed = collapsedRoads.collapsedCount;
  stats.droppedRoadBudget = roadSelection.droppedBudget;

  collapsedLineCandidates.sort((left, right) => {
    const rankDifference = right.rank - left.rank;
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return right.length - left.length;
  });

  const selectedContinuousLineIds = selectContinuousLineCandidates(collapsedLineCandidates);
  const continuousLineCellCounts = buildContinuousLineCellCounts(
    collapsedLineCandidates,
    selectedContinuousLineIds,
  );

  const occupiedLines = new Map<string, number>();
  const occupiedRoads = new Map<string, number>();
  const selectedRoadCellCounts = buildSelectedRoadCellCounts(
    collapsedLineCandidates,
    roadSelection.selectedIds,
    roadGraph,
  );

  for (const candidate of collapsedLineCandidates) {
    const isSelectedRoad = roadSelection.selectedIds.has(candidate.id);

    if (isRoadLike(candidate.kind) && !isSelectedRoad) {
      continue;
    }

    if (isRoadLike(candidate.kind) && isSelectedRoad) {
      const snapped = snapSelectedRoadEndpointsToNetwork(
        candidate,
        roadGraph,
        selectedRoadCellCounts,
        options.bbox,
        options.width,
        options.height,
        options.roadNetworkDetail,
      );
      const keptCells = rasterizeProjectedLine(snapped.projected);
      curated.push({
        ...candidate.feature,
        id: `${candidate.id}:network`,
        coordinates: snapped.coordinates,
      });
      stats.linesKept += 1;

      for (const cells of keptCells) {
        updateOccupancy(cells, occupiedLines, candidate.rank);
        if (candidate.kind !== 'path') {
          updateOccupancy(cells, occupiedRoads, candidate.rank);
        }
      }
      continue;
    }

    if (continuousLineKind(candidate)) {
      if (!selectedContinuousLineIds.has(candidate.id)) {
        stats.droppedOverlappingLines += 1;
        continue;
      }

      const snapped = snapContinuousLineEndpoints(
        candidate,
        continuousLineCellCounts.get(candidate.kind)!,
        options.bbox,
        options.width,
        options.height,
      );
      const keptCells = rasterizeProjectedLine(snapped.projected);
      curated.push({
        ...candidate.feature,
        id: `${candidate.id}:continuous`,
        coordinates: snapped.coordinates,
      });
      stats.linesKept += 1;

      for (const cells of keptCells) {
        updateOccupancy(cells, occupiedLines, candidate.rank);
      }
      continue;
    }

    const thinned = thinLineCandidate(candidate, occupiedLines, occupiedRoads);
    if (!thinned.keptRuns.length) {
      if (thinned.adjacentDropped > thinned.overlapDropped) {
        stats.droppedAdjacentPaths += 1;
      } else {
        stats.droppedOverlappingLines += 1;
      }
      continue;
    }

    thinned.keptRuns.forEach((coordinates, index) => {
      curated.push({
        ...candidate.feature,
        id: `${candidate.id}:thin:${index}`,
        coordinates,
      });
      stats.linesKept += 1;
    });

    for (const cells of thinned.keptCells) {
      updateOccupancy(cells, occupiedLines, candidate.rank);
      if (isRoadLike(candidate.kind) && candidate.kind !== 'path') {
        updateOccupancy(cells, occupiedRoads, candidate.rank);
      }
    }
  }

  if (!useSourceZoomRoadNetwork) {
    const disconnectedRoadsDropped = pruneCuratedDisconnectedRoads(
      curated,
      options.bbox,
      options.width,
      options.height,
    );
    if (disconnectedRoadsDropped > 0) {
      stats.linesKept = Math.max(0, stats.linesKept - disconnectedRoadsDropped);
      stats.droppedRoadBudget += disconnectedRoadsDropped;
    }
  }

  const keptMarkerPositions: GridPoint[] = [];
  const occupiedCells = new Set<string>();
  const prioritizedPoints = [...points].sort((left, right) => {
    const priorityDiff = markerPriority(right) - markerPriority(left);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const leftNamed = left.name ? 1 : 0;
    const rightNamed = right.name ? 1 : 0;
    return rightNamed - leftNamed;
  });

  for (const point of prioritizedPoints) {
    const kind = classifyMarker(point);
    if (!kind) {
      stats.droppedUnclassified += 1;
      continue;
    }
    if (stats.markersKept >= profile.maxMarkers) {
      stats.droppedMarkerBudget += 1;
      continue;
    }

    const position = projectToGrid(point.coordinates, options.bbox, options.width, options.height);
    const cellKey = markerCellKey(position);
    if (occupiedCells.has(cellKey)) {
      stats.droppedCrowdedMarkers += 1;
      continue;
    }

    if (keptMarkerPositions.some((existing) => distance(existing, position) < profile.markerMinDistance)) {
      stats.droppedCrowdedMarkers += 1;
      continue;
    }

    curated.push(point);
    keptMarkerPositions.push(position);
    occupiedCells.add(cellKey);
    stats.markersKept += 1;
  }

  stats.curatedCount = curated.length;
  return {
    features: curated,
    stats,
  };
}
