import type { PatternDocument } from '../core/pattern/compilePattern';

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

export function drawChartPreview(
  canvas: HTMLCanvasElement,
  pattern: PatternDocument,
  cellSize: number,
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

      context.fillStyle = cell.color;
      context.fillRect(left, top, cellSize, cellSize);

      context.fillStyle = '#11231c';
      context.font = `${Math.max(8, Math.floor(cellSize * 0.56))}px "Avenir Next", sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(cell.symbol, left + cellSize / 2, top + cellSize / 2 + 0.5);
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
  for (let x = 0; x <= pattern.width; x += 10) {
    context.beginPath();
    context.moveTo(x * cellSize, 0);
    context.lineTo(x * cellSize, pattern.height * cellSize);
    context.stroke();
  }
  for (let y = 0; y <= pattern.height; y += 10) {
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
    const radius = Math.max(5, cellSize * 0.32);

    context.fillStyle = marker.color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#ffffff';
    context.font = `700 ${Math.max(7, Math.floor(cellSize * 0.44))}px "Avenir Next", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(marker.symbol, x, y + 0.5);
  }

  context.restore();
}
