import type { PatternCellCorner, PatternDocument } from '../core/pattern/compilePattern';

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas is unavailable');
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function drawFrenchKnot(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  radius: number,
): void {
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = 'rgba(255, 247, 239, 0.75)';
  context.lineWidth = Math.max(1, radius * 0.33);
  context.beginPath();
  context.arc(x - radius * 0.18, y - radius * 0.18, radius * 0.5, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = 'rgba(255, 255, 255, 0.45)';
  context.beginPath();
  context.arc(x - radius * 0.2, y - radius * 0.25, Math.max(1, radius * 0.18), 0, Math.PI * 2);
  context.fill();
}

function drawCross(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  size: number,
  color: string,
  lineWidth: number,
): void {
  const margin = Math.max(0.8, size * 0.18);
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(left + margin, top + margin);
  context.lineTo(left + size - margin, top + size - margin);
  context.moveTo(left + size - margin, top + margin);
  context.lineTo(left + margin, top + size - margin);
  context.stroke();
}

function cornerPoint(
  left: number,
  top: number,
  size: number,
  corner: PatternCellCorner,
): { x: number; y: number } {
  switch (corner) {
    case 'topLeft':
      return { x: left, y: top };
    case 'topRight':
      return { x: left + size, y: top };
    case 'bottomLeft':
      return { x: left, y: top + size };
    case 'bottomRight':
      return { x: left + size, y: top + size };
  }
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

function adjacentDiagonalEndpoints(
  left: number,
  top: number,
  size: number,
  corner: PatternCellCorner,
): Array<{ x: number; y: number }> {
  switch (corner) {
    case 'topRight':
    case 'bottomLeft':
      return [
        { x: left, y: top },
        { x: left + size, y: top + size },
      ];
    case 'topLeft':
    case 'bottomRight':
      return [
        { x: left + size, y: top },
        { x: left, y: top + size },
      ];
  }
}

function drawThreeQuarterStitch(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  size: number,
  color: string,
  shortCorner: PatternCellCorner,
  lineWidth: number,
): void {
  const gap = Math.max(0.8, size * 0.18);
  const [fullStartRaw, fullEndRaw] = adjacentDiagonalEndpoints(left, top, size, shortCorner);
  const centerX = left + size / 2;
  const centerY = top + size / 2;
  const shortStart = cornerPoint(left + gap, top + gap, size - gap * 2, shortCorner);
  const fullStart =
    fullStartRaw.x < centerX
      ? { x: fullStartRaw.x + gap, y: fullStartRaw.y + (fullStartRaw.y < centerY ? gap : -gap) }
      : { x: fullStartRaw.x - gap, y: fullStartRaw.y + (fullStartRaw.y < centerY ? gap : -gap) };
  const fullEnd =
    fullEndRaw.x < centerX
      ? { x: fullEndRaw.x + gap, y: fullEndRaw.y + (fullEndRaw.y < centerY ? gap : -gap) }
      : { x: fullEndRaw.x - gap, y: fullEndRaw.y + (fullEndRaw.y < centerY ? gap : -gap) };

  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(fullStart.x, fullStart.y);
  context.lineTo(fullEnd.x, fullEnd.y);
  context.moveTo(shortStart.x, shortStart.y);
  context.lineTo(centerX, centerY);
  context.stroke();
}

function drawAccentFill(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  size: number,
  shortCorner: PatternCellCorner,
  color: string,
): void {
  const [from, to] = adjacentDiagonalEndpoints(left, top, size, shortCorner);
  const accentCorner = oppositeCorner(shortCorner);
  const accentPoint = cornerPoint(left, top, size, accentCorner);

  context.fillStyle = color;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.lineTo(accentPoint.x, accentPoint.y);
  context.closePath();
  context.fill();
}

function drawQuarterGuide(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  size: number,
  shortCorner: PatternCellCorner,
): void {
  context.strokeStyle = 'rgba(16, 35, 29, 0.08)';
  context.lineWidth = 0.6;
  context.lineCap = 'round';
  context.beginPath();
  const corner = cornerPoint(left, top, size, shortCorner);
  context.moveTo(corner.x, corner.y);
  context.lineTo(left + size / 2, top + size / 2);
  context.stroke();
}

export function drawStitchPreview(
  canvas: HTMLCanvasElement,
  pattern: PatternDocument,
  cellSize: number,
): void {
  const padding = 24;
  const width = pattern.width * cellSize + padding * 2;
  const height = pattern.height * cellSize + padding * 2;
  const context = setupCanvas(canvas, width, height);

  context.fillStyle = '#efe2ca';
  context.fillRect(0, 0, width, height);

  context.save();
  context.translate(padding, padding);

  for (let y = 0; y < pattern.height; y += 1) {
    for (let x = 0; x < pattern.width; x += 1) {
      const cell = pattern.cells[y][x];
      const left = x * cellSize;
      const top = y * cellSize;
      const centerX = left + cellSize / 2;
      const centerY = top + cellSize / 2;

      context.fillStyle = 'rgba(255, 255, 255, 0.24)';
      context.fillRect(left, top, cellSize, cellSize);

      if (cell.fractional?.kind === 'threeQuarter') {
        drawAccentFill(
          context,
          left,
          top,
          cellSize,
          cell.fractional.shortCorner,
          `${cell.fractional.accent.color}88`,
        );
        drawThreeQuarterStitch(
          context,
          left,
          top,
          cellSize,
          cell.color,
          cell.fractional.shortCorner,
          Math.max(1.4, cellSize * 0.18),
        );
        drawQuarterGuide(context, left, top, cellSize, cell.fractional.shortCorner);
      } else {
        drawCross(context, left, top, cellSize, cell.color, Math.max(1.5, cellSize * 0.18));
      }

      context.strokeStyle = 'rgba(16, 35, 29, 0.08)';
      context.lineWidth = 0.6;
      context.beginPath();
      context.arc(centerX, centerY, cellSize * 0.43, 0, Math.PI * 2);
      context.stroke();
    }
  }

  for (const segment of pattern.backstitches) {
    context.strokeStyle = segment.color;
    context.lineWidth = Math.max(1.5, segment.weight + 0.4);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(segment.from.x * cellSize, segment.from.y * cellSize);
    context.lineTo(segment.to.x * cellSize, segment.to.y * cellSize);
    context.stroke();
  }

  for (const marker of pattern.markers) {
    const x = marker.position.x * cellSize;
    const y = marker.position.y * cellSize;
    drawFrenchKnot(context, x, y, marker.color, Math.max(4.8, cellSize * 0.24));
  }

  context.restore();
}
