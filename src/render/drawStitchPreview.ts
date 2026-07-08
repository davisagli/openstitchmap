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

function cornerPoint(
  left: number,
  top: number,
  size: number,
  corner: PatternCellCorner,
  inset: number,
): { x: number; y: number } {
  switch (corner) {
    case 'topLeft':
      return { x: left + inset, y: top + inset };
    case 'topRight':
      return { x: left + size - inset, y: top + inset };
    case 'bottomLeft':
      return { x: left + inset, y: top + size - inset };
    case 'bottomRight':
      return { x: left + size - inset, y: top + size - inset };
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

function adjacentDiagonalCorners(
  corner: PatternCellCorner,
): [PatternCellCorner, PatternCellCorner] {
  switch (corner) {
    case 'topRight':
    case 'bottomLeft':
      return ['topLeft', 'bottomRight'];
    case 'topLeft':
    case 'bottomRight':
      return ['topRight', 'bottomLeft'];
  }
}

function drawThread(
  context: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  width: number,
  bend: number,
  profile: 'crossStitch' | 'backstitch' = 'crossStitch',
): void {
  const middleX = (from.x + to.x) / 2 + bend;
  const middleY = (from.y + to.y) / 2 - bend;
  const isBackstitch = profile === 'backstitch';
  const shadowOffsetX = isBackstitch ? 0.7 : 0.4;
  const shadowOffsetY = isBackstitch ? 0.8 : 0.5;

  context.lineCap = 'round';
  context.lineJoin = 'round';

  context.strokeStyle = isBackstitch ? 'rgba(60, 42, 27, 0.24)' : 'rgba(60, 42, 27, 0.13)';
  context.lineWidth = width + (isBackstitch ? 1.4 : 0.8);
  context.beginPath();
  context.moveTo(from.x + shadowOffsetX, from.y + shadowOffsetY);
  context.quadraticCurveTo(
    middleX + shadowOffsetX,
    middleY + shadowOffsetY,
    to.x + shadowOffsetX,
    to.y + shadowOffsetY,
  );
  context.stroke();

  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.quadraticCurveTo(middleX, middleY, to.x, to.y);
  context.stroke();

  context.strokeStyle = 'rgba(255, 255, 255, 0.24)';
  context.lineWidth = Math.max(0.6, width * 0.2);
  context.beginPath();
  context.moveTo(from.x - 0.35, from.y - 0.35);
  context.quadraticCurveTo(middleX - 0.35, middleY - 0.35, to.x - 0.35, to.y - 0.35);
  context.stroke();
}

function drawFabric(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  patternWidth: number,
  patternHeight: number,
  cellSize: number,
  padding: number,
): void {
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#eadfc8');
  background.addColorStop(0.5, '#dfd0b2');
  background.addColorStop(1, '#e8dcc3');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  context.lineWidth = Math.max(0.45, cellSize * 0.045);
  for (let x = 0; x <= width; x += Math.max(2.5, cellSize / 3)) {
    context.strokeStyle = x % 2 < 1 ? 'rgba(255, 250, 231, 0.22)' : 'rgba(91, 69, 43, 0.08)';
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + Math.sin(x * 0.17) * 1.2, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += Math.max(2.5, cellSize / 3)) {
    context.strokeStyle = y % 2 < 1 ? 'rgba(255, 250, 231, 0.18)' : 'rgba(91, 69, 43, 0.07)';
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y + Math.cos(y * 0.19) * 1.2);
    context.stroke();
  }

  context.fillStyle = 'rgba(73, 54, 34, 0.22)';
  for (let y = 0; y <= patternHeight; y += 1) {
    for (let x = 0; x <= patternWidth; x += 1) {
      context.beginPath();
      context.arc(
        padding + x * cellSize,
        padding + y * cellSize,
        Math.max(0.65, cellSize * 0.065),
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }
}

function drawFrenchKnot(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  radius: number,
): void {
  context.fillStyle = 'rgba(60, 42, 27, 0.28)';
  context.beginPath();
  context.ellipse(x + 1, y + 1.4, radius * 1.05, radius * 0.9, 0, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = color;
  context.lineWidth = Math.max(1.4, radius * 0.42);
  context.lineCap = 'round';
  for (let turn = 0; turn < 3; turn += 1) {
    context.beginPath();
    context.arc(x, y, radius * (0.35 + turn * 0.22), turn * 1.5, Math.PI * (1.5 + turn * 0.65));
    context.stroke();
  }

  context.fillStyle = 'rgba(255, 255, 255, 0.32)';
  context.beginPath();
  context.arc(x - radius * 0.25, y - radius * 0.3, Math.max(0.8, radius * 0.16), 0, Math.PI * 2);
  context.fill();
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

  drawFabric(context, width, height, pattern.width, pattern.height, cellSize, padding);

  context.save();
  context.translate(padding, padding);

  for (let y = 0; y < pattern.height; y += 1) {
    for (let x = 0; x < pattern.width; x += 1) {
      const cell = pattern.cells[y][x];
      const left = x * cellSize;
      const top = y * cellSize;
      const inset = Math.max(0.5, cellSize * 0.07);
      const center = { x: left + cellSize / 2, y: top + cellSize / 2 };
      const threadWidth = Math.max(2.1, cellSize * 0.27);
      const bend = (((x * 17 + y * 11) % 7) - 3) * cellSize * 0.025;

      if (cell.fractional?.kind === 'threeQuarter') {
        const [fullFrom, fullTo] = adjacentDiagonalCorners(cell.fractional.shortCorner);
        drawThread(
          context,
          cornerPoint(left, top, cellSize, fullFrom, inset),
          cornerPoint(left, top, cellSize, fullTo, inset),
          cell.color,
          threadWidth,
          bend,
        );
        drawThread(
          context,
          cornerPoint(left, top, cellSize, cell.fractional.shortCorner, inset),
          center,
          cell.color,
          threadWidth,
          -bend,
        );
        drawThread(
          context,
          cornerPoint(left, top, cellSize, oppositeCorner(cell.fractional.shortCorner), inset),
          center,
          cell.fractional.accent.color,
          threadWidth,
          bend,
        );
      } else {
        drawThread(
          context,
          cornerPoint(left, top, cellSize, 'topLeft', inset),
          cornerPoint(left, top, cellSize, 'bottomRight', inset),
          cell.color,
          threadWidth,
          bend,
        );
        drawThread(
          context,
          cornerPoint(left, top, cellSize, 'topRight', inset),
          cornerPoint(left, top, cellSize, 'bottomLeft', inset),
          cell.color,
          threadWidth,
          -bend,
        );
      }
    }
  }

  for (const segment of pattern.backstitches) {
    const from = { x: segment.from.x * cellSize, y: segment.from.y * cellSize };
    const to = { x: segment.to.x * cellSize, y: segment.to.y * cellSize };
    drawThread(
      context,
      from,
      to,
      segment.color,
      Math.max(1.35, segment.weight + 0.35),
      0,
      'backstitch',
    );
  }

  for (const marker of pattern.markers) {
    drawFrenchKnot(
      context,
      marker.position.x * cellSize,
      marker.position.y * cellSize,
      marker.color,
      Math.max(4.6, cellSize * 0.25),
    );
  }

  context.restore();

  const vignette = context.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.25,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  vignette.addColorStop(0, 'rgba(255, 255, 255, 0)');
  vignette.addColorStop(1, 'rgba(63, 43, 25, 0.12)');
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}
