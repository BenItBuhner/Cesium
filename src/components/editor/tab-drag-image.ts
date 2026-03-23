/** 1×1 transparent GIF — cheap drag preview so the browser does not snapshot the whole tab. */
const TRANSPARENT_PIXEL_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

let cached: HTMLImageElement | null = null;

export function setMinimalTabDragImage(dataTransfer: DataTransfer) {
  if (typeof window === "undefined") return;
  if (!cached) {
    cached = new Image();
    cached.src = TRANSPARENT_PIXEL_GIF;
  }
  try {
    dataTransfer.setDragImage(cached, 0, 0);
  } catch {
    /* ignore — some environments restrict setDragImage */
  }
}
