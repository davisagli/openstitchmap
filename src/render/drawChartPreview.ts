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
  context.fillStyle = '#fffdf7';
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = color;
  context.lineWidth = Math.max(1, radius * 0.5);
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, Math.max(1.2, radius * 0.42), 0, Math.PI * 2);
  context.fill();
}

function drawCellSymbol(
  context: CanvasRenderingContext2D,
  symbol: string,
  x: number,
  y: number,
  fontSize: number,
): void {
  context.fillStyle = '#11231c';
  context.font = `${fontSize}px "Avenir Next", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(symbol, x, y + 0.5);
}

function triangleVertices(
  left: number,
  top: number,
  size: number,
  corner: PatternCellCorner,
): Array<{ x: number; y: number }> {
  switch (corner) {
    case 'topLeft':
      return [
        { x: left, y: top },
        { x: left + size, y: top },
        { x: left, y: top + size },
      ];
    case 'topRight':
      return [
        { x: left + size, y: top },
        { x: left, y: top },
        { x: left + size, y: top + size },
      ];
    case 'bottomLeft':
      return [
        { x: left, y: top + size },
        { x: left, y: top },
        { x: left + size, y: top + size },
      ];
    case 'bottomRight':
      return [
        { x: left + size, y: top + size },
        { x: left + size, y: top },
        { x: left, y: top + size },
      ];
  }
}

function diagonalEndpoints(
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

export function drawChartPreview(
  canvas: HTMLCanvasElement,
  pattern: PatternDocument,
  cellSize: number,
  majorGridPhase: { x: number; y: number } = { x: 0, y: 0 },
): void {
  const padding = 24;
  const width = pattern.width * cellSize + padding * 2;
  const height = pattern.height * cellSize + padding * 2;
  const context = setupCanvas(canvas, width, height);

  context.fillStyle = '#fffdf7';
  context.fillRect(0, 0, width, height);

  context.save();
  context.translate(padding, padding);

  for (let y = 0; y < pattern.height; y += 1) {
    for (let x = 0; x < pattern.width; x += 1) {
      const cell = pattern.cells[y][x];
      const left = x * cellSize;
      const top = y * cellSize;

      if (cell.fractional?.kind === 'threeQuarter') {
        context.fillStyle = cell.fractional.accent.color;
        context.fillRect(left, top, cellSize, cellSize);

        const [corner, first, second] = triangleVertices(left, top, cellSize, cell.fractional.shortCorner);
        context.fillStyle = cell.color;
        context.beginPath();
        context.moveTo(corner.x, corner.y);
        context.lineTo(first.x, first.y);
        context.lineTo(second.x, second.y);
        context.closePath();
        context.fill();

        const [from, to] = diagonalEndpoints(left, top, cellSize, cell.fractional.shortCorner);
        context.strokeStyle = 'rgba(16, 35, 29, 0.22)';
        context.lineWidth = Math.max(0.9, cellSize * 0.06);
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
        drawCellSymbol(
          context,
          cell.symbol,
          left + cellSize / 2,
          top + cellSize / 2,
          Math.max(7, Math.floor(cellSize * 0.48)),
        );
      } else {
        context.fillStyle = cell.color;
        context.fillRect(left, top, cellSize, cellSize);
        drawCellSymbol(
          context,
          cell.symbol,
          left + cellSize / 2,
          top + cellSize / 2,
          Math.max(8, Math.floor(cellSize * 0.56)),
        );
      }
    }
  }

  context.strokeStyle = 'rgba(16, 35, 29, 0.15)';
  context.lineWidth = 1;
  for (let x = 0; x <= pattern.width; x += 1) {
    context.beginPath();
    context.moveTo(x * cellSize, 0);
    context.lineTo(x * cellSize, pattern.height * cellSize);
    context.stroke();
  }
  for (let y = 0; y <= pattern.height; y += 1) {
    context.beginPath();
    context.moveTo(0, y * cellSize);
    context.lineTo(pattern.width * cellSize, y * cellSize);
    context.stroke();
  }

  context.strokeStyle = 'rgba(16, 35, 29, 0.35)';
  context.lineWidth = 1.5;
  for (let x = majorGridPhase.x; x <= pattern.width; x += 10) {
    context.beginPath();
    context.moveTo(x * cellSize, 0);
    context.lineTo(x * cellSize, pattern.height * cellSize);
    context.stroke();
  }
  for (let y = majorGridPhase.y; y <= pattern.height; y += 10) {
    context.beginPath();
    context.moveTo(0, y * cellSize);
    context.lineTo(pattern.width * cellSize, y * cellSize);
    context.stroke();
  }

  for (const segment of pattern.backstitches) {
    context.strokeStyle = segment.color;
    context.lineWidth = Math.max(1, segment.weight);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(segment.from.x * cellSize, segment.from.y * cellSize);
    context.lineTo(segment.to.x * cellSize, segment.to.y * cellSize);
    context.stroke();
  }

  for (const marker of pattern.markers) {
    const x = marker.position.x * cellSize;
    const y = marker.position.y * cellSize;
    drawFrenchKnot(context, x, y, marker.color, Math.max(4.5, cellSize * 0.26));
  }

  context.restore();
}
