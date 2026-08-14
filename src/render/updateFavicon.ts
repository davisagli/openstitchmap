const FAVICON_SIZE = 64;
const FAVICON_PADDING = 3;

interface FaviconViewport {
  width: number;
  height: number;
  canvasOffsetX: number;
  canvasOffsetY: number;
}

export function updateFaviconFromCanvas(
  sourceCanvas: HTMLCanvasElement,
  viewport: FaviconViewport,
): void {
  const renderedWidth = Number.parseFloat(sourceCanvas.style.width);
  const renderedHeight = Number.parseFloat(sourceCanvas.style.height);
  if (
    !Number.isFinite(renderedWidth) ||
    !Number.isFinite(renderedHeight) ||
    renderedWidth <= 0 ||
    renderedHeight <= 0
  ) {
    return;
  }

  const sourceScaleX = sourceCanvas.width / renderedWidth;
  const sourceScaleY = sourceCanvas.height / renderedHeight;
  const sourceX = Math.max(0, -viewport.canvasOffsetX * sourceScaleX);
  const sourceY = Math.max(0, -viewport.canvasOffsetY * sourceScaleY);
  const sourceWidth = Math.min(
    viewport.width * sourceScaleX,
    sourceCanvas.width - sourceX,
  );
  const sourceHeight = Math.min(
    viewport.height * sourceScaleY,
    sourceCanvas.height - sourceY,
  );
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  const favicon = document.createElement("canvas");
  favicon.width = FAVICON_SIZE;
  favicon.height = FAVICON_SIZE;
  const context = favicon.getContext("2d");
  if (!context) {
    return;
  }

  context.fillStyle = "#fffdf7";
  context.fillRect(0, 0, FAVICON_SIZE, FAVICON_SIZE);

  const availableSize = FAVICON_SIZE - FAVICON_PADDING * 2;
  const scale = Math.min(
    availableSize / viewport.width,
    availableSize / viewport.height,
  );
  const targetWidth = viewport.width * scale;
  const targetHeight = viewport.height * scale;
  const targetX = (FAVICON_SIZE - targetWidth) / 2;
  const targetY = (FAVICON_SIZE - targetHeight) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    sourceCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    targetX,
    targetY,
    targetWidth,
    targetHeight,
  );
  context.strokeStyle = "rgba(16, 35, 29, 0.36)";
  context.lineWidth = 1;
  context.strokeRect(
    targetX + 0.5,
    targetY + 0.5,
    Math.max(0, targetWidth - 1),
    Math.max(0, targetHeight - 1),
  );

  let faviconLink = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"]',
  );
  if (!faviconLink) {
    faviconLink = document.createElement("link");
    faviconLink.rel = "icon";
    document.head.append(faviconLink);
  }
  faviconLink.type = "image/png";
  faviconLink.href = favicon.toDataURL("image/png");
}
