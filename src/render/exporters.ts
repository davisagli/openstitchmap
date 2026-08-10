import type { PatternDocument } from '../core/pattern/compilePattern';

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportPatternJson(pattern: PatternDocument): void {
  const blob = new Blob([JSON.stringify(pattern, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, `${slugify(pattern.title)}.json`);
}

export function exportCanvasPng(
  canvas: HTMLCanvasElement,
  filename: string,
  attribution?: string,
): void {
  const exportCanvas = document.createElement('canvas');
  const pixelRatio = window.devicePixelRatio || 1;
  const footerHeight = attribution ? Math.round(32 * pixelRatio) : 0;
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height + footerHeight;

  const context = exportCanvas.getContext('2d');
  if (!context) {
    return;
  }

  context.drawImage(canvas, 0, 0);

  if (attribution) {
    const horizontalPadding = Math.round(10 * pixelRatio);
    const availableWidth = exportCanvas.width - horizontalPadding * 2;
    let fontSize = Math.round(10 * pixelRatio);

    context.fillStyle = '#fffdf7';
    context.fillRect(0, canvas.height, exportCanvas.width, footerHeight);
    context.fillStyle = '#42554d';
    context.textAlign = 'right';
    context.textBaseline = 'middle';

    do {
      context.font = `${fontSize}px "Avenir Next", "Segoe UI", sans-serif`;
      fontSize -= 1;
    } while (
      fontSize > Math.round(7 * pixelRatio) &&
      context.measureText(attribution).width > availableWidth
    );

    context.fillText(
      attribution,
      exportCanvas.width - horizontalPadding,
      canvas.height + footerHeight / 2,
      availableWidth,
    );
  }

  exportCanvas.toBlob((blob) => {
    if (!blob) {
      return;
    }

    downloadBlob(blob, filename);
  }, 'image/png');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
