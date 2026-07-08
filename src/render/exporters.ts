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

export function exportCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
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
