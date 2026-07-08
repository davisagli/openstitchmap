import type { BBox, LineFeature, MapFeature, PointFeature, PolygonFeature, Position } from '../osm';
import { classifyLine, classifyMarker, classifyPolygon } from './compilePattern';

export type DetailLevel = 'low' | 'medium' | 'high';

export interface CurateFeaturesOptions {
  bbox: BBox;
  width: number;
  height: number;
  detailLevel: DetailLevel;
  includeMinorRoads: boolean;
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

function interpolatePoint(left: GridPoint, right: GridPoint, ratio: number): GridPoint {
  return {
    x: left.x + (right.x - left.x) * ratio,
    y: left.y + (right.y - left.y) * ratio,
  };
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

function baseLineRank(kind: NonNullable<ReturnType<typeof classifyLine>>): number {
  switch (kind) {
    case 'primaryRoad':
      return 320;
    case 'rail':
      return 290;
    case 'boundary':
      return 260;
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

function linePriority(feature: LineFeature, kind: NonNullable<ReturnType<typeof classifyLine>>): number {
  let rank = baseLineRank(kind) + roadDetailBonus(feature);

  if (feature.name) {
    rank += 6;
  }

  if (feature.tags.service) {
    rank -= 16;
  }

  if (feature.tags.brunnel === 'tunnel' || feature.tags.tunnel === 'yes') {
    rank -= 18;
  }

  if (feature.tags.source_layer === 'transportation_name') {
    rank -= 90;
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

function orientProjectedLike(reference: GridPoint[], candidate: GridPoint[]): GridPoint[] {
  if (lineHeadingSimilarity(reference, candidate) < 0) {
    return [...candidate].reverse();
  }

  return candidate;
}

function resampleProjectedLine(projected: GridPoint[], sampleCount: number): GridPoint[] {
  if (projected.length <= 1 || sampleCount <= 1) {
    return projected.slice(0, sampleCount);
  }

  const distances = [0];
  for (let index = 1; index < projected.length; index += 1) {
    distances.push(distances[index - 1] + distance(projected[index - 1], projected[index]));
  }

  const totalLength = distances[distances.length - 1];
  if (totalLength === 0) {
    return Array.from({ length: sampleCount }, () => projected[0]);
  }

  const samples: GridPoint[] = [];
  let segmentIndex = 1;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const targetDistance = (sampleIndex / (sampleCount - 1)) * totalLength;

    while (segmentIndex < distances.length - 1 && distances[segmentIndex] < targetDistance) {
      segmentIndex += 1;
    }

    const startIndex = Math.max(0, segmentIndex - 1);
    const endIndex = Math.min(projected.length - 1, segmentIndex);
    const startDistance = distances[startIndex];
    const endDistance = distances[endIndex];
    const ratio = endDistance === startDistance ? 0 : (targetDistance - startDistance) / (endDistance - startDistance);
    samples.push(interpolatePoint(projected[startIndex], projected[endIndex], ratio));
  }

  return samples;
}

function averageProjectedLines(lines: GridPoint[][], sampleCount: number): GridPoint[] {
  const resampled = lines.map((line) => resampleProjectedLine(line, sampleCount));
  return Array.from({ length: sampleCount }, (_, index) => {
    const total = resampled.reduce(
      (accumulator, line) => ({
        x: accumulator.x + line[index].x,
        y: accumulator.y + line[index].y,
      }),
      { x: 0, y: 0 },
    );

    return {
      x: total.x / resampled.length,
      y: total.y / resampled.length,
    };
  });
}

function corridorSimilarity(left: LineCandidate, right: LineCandidate): number {
  const leftCells = flattenUniqueCells(rasterizeProjectedLine(left.projected));
  const rightCells = flattenUniqueCells(rasterizeProjectedLine(right.projected));
  if (!leftCells.length || !rightCells.length) {
    return 0;
  }

  const rightOccupied = new Map<string, number>();
  const leftOccupied = new Map<string, number>();
  updateOccupancy(rightCells, rightOccupied, right.rank);
  updateOccupancy(leftCells, leftOccupied, left.rank);

  const leftCoverage = nearbyCoverageRatio(leftCells, rightOccupied, right.rank - 40, 1);
  const rightCoverage = nearbyCoverageRatio(rightCells, leftOccupied, left.rank - 40, 1);
  return Math.min(leftCoverage, rightCoverage);
}

function isGraphRoadCandidate(candidate: LineCandidate): boolean {
  return candidate.kind === 'primaryRoad' || candidate.kind === 'secondaryRoad' || candidate.kind === 'rail';
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
  const primaryCandidates = candidates
    .filter((candidate) => candidate.kind === 'primaryRoad')
    .sort((left, right) => {
      const rankDifference = right.rank - left.rank;
      if (rankDifference !== 0) {
        return rankDifference;
      }

      return right.length - left.length;
    });

  const corridorAnchors: LineCandidate[] = [];

  for (const candidate of primaryCandidates) {
    const candidateStatsEntry = candidateStats.get(candidate.id);
    if (!candidateStatsEntry) {
      corridorAnchors.push(candidate);
      continue;
    }

    let matchedAnchorId: string | null = null;

    for (const anchor of corridorAnchors) {
      const anchorStats = candidateStats.get(anchor.id);
      if (!anchorStats) {
        continue;
      }

      const similarity = corridorSimilarity(anchor, candidate);
      const headingSimilarity = Math.abs(lineHeadingSimilarity(anchor.projected, candidate.projected));
      const lengthRatio = Math.min(anchor.length, candidate.length) / Math.max(anchor.length, candidate.length);
      const importanceGap = anchorStats.importance - candidateStatsEntry.importance;

      if (
        similarity >= 0.63 &&
        headingSimilarity >= 0.74 &&
        lengthRatio >= 0.4 &&
        importanceGap >= -1 &&
        candidateStatsEntry.junctionCount <= anchorStats.junctionCount + 1 &&
        candidateStatsEntry.branchingEndpoints <= anchorStats.branchingEndpoints + 1
      ) {
        matchedAnchorId = anchor.id;
        break;
      }
    }

    if (matchedAnchorId) {
      duplicateAnchors.set(candidate.id, matchedAnchorId);
      continue;
    }

    corridorAnchors.push(candidate);
  }

  const candidateRoles = new Map<string, GraphRoadRole>();

  for (const candidate of candidates) {
    const stats = candidateStats.get(candidate.id);

    if (candidate.kind === 'primaryRoad') {
      candidateRoles.set(candidate.id, duplicateAnchors.has(candidate.id) ? 'duplicate' : 'corridor');
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

function collapsePrimaryCorridors(
  candidates: LineCandidate[],
  graph: SnappedRoadGraph,
  bbox: BBox,
  width: number,
  height: number,
): LineCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const clusters = new Map<string, LineCandidate[]>();
  const passthrough: LineCandidate[] = [];

  for (const candidate of candidates) {
    const role = graph.candidateRoles.get(candidate.id) ?? 'corridor';

    if (role === 'duplicate') {
      const anchorId = graph.duplicateAnchors.get(candidate.id);
      if (!anchorId) {
        passthrough.push(candidate);
        continue;
      }

      const anchor = byId.get(anchorId);
      if (!anchor) {
        passthrough.push(candidate);
        continue;
      }

      if (!clusters.has(anchorId)) {
        clusters.set(anchorId, [anchor]);
      }
      clusters.get(anchorId)?.push(candidate);
      continue;
    }

    if (role === 'corridor') {
      if (!clusters.has(candidate.id)) {
        clusters.set(candidate.id, [candidate]);
      }
      continue;
    }

    passthrough.push(candidate);
  }

  const collapsed: LineCandidate[] = [];

  for (const anchor of candidates) {
    const cluster = clusters.get(anchor.id);
    if (!cluster) {
      continue;
    }

    if (cluster.length === 1) {
      collapsed.push(anchor);
      continue;
    }

    const orientedProjected = cluster.map((candidate) => orientProjectedLike(anchor.projected, candidate.projected));
    const sampleCount = Math.max(
      6,
      Math.round(Math.max(...orientedProjected.map((projected) => lineLength(projected))) * 1.25),
    );
    const averagedProjected = averageProjectedLines(orientedProjected, sampleCount);
    const averagedCoordinates = averagedProjected.map((point) => unprojectFromGrid(point, bbox, width, height));

    collapsed.push({
      id: anchor.id,
      feature: anchor.feature,
      kind: anchor.kind,
      coordinates: averagedCoordinates,
      projected: averagedProjected,
      rank: Math.max(...cluster.map((candidate) => candidate.rank)) + cluster.length * 4,
      length: lineLength(averagedProjected),
    });
  }

  return [...collapsed, ...passthrough];
}

function isRoadLike(kind: NonNullable<ReturnType<typeof classifyLine>>): boolean {
  return kind === 'primaryRoad' || kind === 'secondaryRoad' || kind === 'path';
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

function shouldKeepContinuousCandidate(
  candidate: LineCandidate,
  occupiedLines: Map<string, number>,
  occupiedRoads: Map<string, number>,
  graph: SnappedRoadGraph,
): boolean {
  const cells = flattenUniqueCells(rasterizeProjectedLine(candidate.projected));
  if (!cells.length) {
    return false;
  }

  const nearbyThreshold = candidate.kind === 'primaryRoad' ? candidate.rank - 30 : candidate.rank - 20;
  const nearbyRoadCoverage = nearbyCoverageRatio(cells, occupiedRoads, nearbyThreshold, 1);
  const exactLineCoverage = coverageRatio(cells, occupiedLines, candidate.rank,);
  const novelCellCount = countNearbyNovelCells(cells, occupiedRoads, nearbyThreshold, 1);
  const endpointConnections = endpointConnectionCount(cells, occupiedRoads, nearbyThreshold, 1);
  const minimumNovelCells = Math.max(3, Math.floor(cells.length * 0.08));

  if (nearbyRoadCoverage >= 0.92 && novelCellCount <= minimumNovelCells) {
    return false;
  }

  if (exactLineCoverage >= 0.84 && nearbyRoadCoverage >= 0.86 && novelCellCount <= minimumNovelCells + 1) {
    return false;
  }

  return novelCellCount >= minimumNovelCells || endpointConnections > 0 || isGraphConnector(candidate, graph);
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
    droppedCrowdedMarkers: 0,
    droppedMarkerBudget: 0,
  };

  const polygons = features.filter((feature): feature is PolygonFeature => feature.type === 'polygon');
  const lines = features.filter((feature): feature is LineFeature => feature.type === 'line');
  const points = features.filter((feature): feature is PointFeature => feature.type === 'point');

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
  }

  const lineCandidates: LineCandidate[] = [];

  for (const line of lines) {
    const kind = classifyLine(line);
    if (!kind) {
      stats.droppedUnclassified += 1;
      continue;
    }

    if (line.tags.source_layer === 'transportation_name') {
      stats.droppedOverlappingLines += 1;
      continue;
    }

    if (!options.includeMinorRoads && (kind === 'secondaryRoad' || kind === 'path')) {
      stats.droppedShortLines += 1;
      continue;
    }

    const simplifiedCoordinates = simplifyCoordinates(
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

    lineCandidates.push({
      id: line.id,
      feature: line,
      kind,
      coordinates: simplifiedCoordinates,
      projected,
      rank: linePriority(line, kind),
      length: lineLength(projected),
    });
  }

  const roadGraph = buildSnappedRoadGraph(lineCandidates);
  const collapsedPrimaryCandidates = collapsePrimaryCorridors(
    lineCandidates.filter((candidate) => candidate.kind === 'primaryRoad'),
    roadGraph,
    options.bbox,
    options.width,
    options.height,
  );
  const collapsedLineCandidates = [
    ...collapsedPrimaryCandidates,
    ...lineCandidates.filter((candidate) => candidate.kind !== 'primaryRoad'),
  ];

  collapsedLineCandidates.sort((left, right) => {
    const rankDifference = right.rank - left.rank;
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return right.length - left.length;
  });

  const occupiedLines = new Map<string, number>();
  const occupiedRoads = new Map<string, number>();

  for (const candidate of collapsedLineCandidates) {
    const graphRole = roadGraph.candidateRoles.get(candidate.id);
    const graphImportance = roadGraph.candidateImportance.get(candidate.id) ?? 0;

    if (candidate.kind === 'primaryRoad' || candidate.kind === 'rail') {
      if (!shouldKeepContinuousCandidate(candidate, occupiedLines, occupiedRoads, roadGraph)) {
        stats.droppedOverlappingLines += 1;
        continue;
      }

      const keptCells = rasterizeProjectedLine(candidate.projected);
      curated.push({
        ...candidate.feature,
        id: `${candidate.feature.id}:continuous`,
        coordinates: candidate.coordinates,
      });
      stats.linesKept += 1;

      for (const cells of keptCells) {
        updateOccupancy(cells, occupiedLines, candidate.rank);
        if (candidate.kind === 'primaryRoad') {
          updateOccupancy(cells, occupiedRoads, candidate.rank);
        }
      }
      continue;
    }

    if (candidate.kind === 'secondaryRoad' && graphRole === 'connector') {
      const connectorCells = roadGraph.candidateCells.get(candidate.id) ?? flattenCellPath(rasterizeProjectedLine(candidate.projected));
      const connectorCoverage = coverageRatio(connectorCells, occupiedLines, candidate.rank);
      const connectorRoadCoverage = nearbyCoverageRatio(
        connectorCells,
        occupiedRoads,
        candidate.rank - Math.min(32, 14 + graphImportance),
        1,
      );

      if (graphImportance >= 5 || connectorCoverage < 0.94 || connectorRoadCoverage < 0.97) {
        const keptCells = rasterizeProjectedLine(candidate.projected);
        curated.push({
          ...candidate.feature,
          id: `${candidate.feature.id}:connector`,
          coordinates: candidate.coordinates,
        });
        stats.linesKept += 1;

        for (const cells of keptCells) {
          updateOccupancy(cells, occupiedLines, candidate.rank);
          updateOccupancy(cells, occupiedRoads, candidate.rank);
        }
        continue;
      }
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
        id: `${candidate.feature.id}:thin:${index}`,
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
