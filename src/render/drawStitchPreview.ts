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
      const margin = Math.max(1, cellSize * 0.18);

      context.fillStyle = 'rgba(255, 255, 255, 0.24)';
      context.fillRect(left, top, cellSize, cellSize);

      context.strokeStyle = cell.color;
      context.lineWidth = Math.max(1.5, cellSize * 0.18);
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(left + margin, top + margin);
      context.lineTo(left + cellSize - margin, top + cellSize - margin);
      context.moveTo(left + cellSize - margin, top + margin);
      context.lineTo(left + margin, top + cellSize - margin);
      context.stroke();

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
    const radius = Math.max(6, cellSize * 0.34);

    context.fillStyle = marker.color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#fff7ef';
    context.font = `700 ${Math.max(8, Math.floor(cellSize * 0.46))}px "Avenir Next", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(marker.symbol, x, y + 0.5);
  }

  context.restore();
}
