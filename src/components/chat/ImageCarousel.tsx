import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCw, X } from "lucide-react";
import type { ImageAttachmentState } from "@/lib/types";

interface ImageCarouselProps {
  images: ImageAttachmentState[];
  onRemove: (localId: string) => void;
  onRetry?: (localId: string) => void;
  size?: "compact" | "expanded";
}

const THUMBNAIL_SIZE = {
  compact: 64,
  expanded: 80,
};

export function ImageCarousel({ images, onRemove, onRetry, size = "compact" }: ImageCarouselProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const dimension = THUMBNAIL_SIZE[size];

  const updateGradients = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const hasOverflow = scrollWidth > clientWidth;

    setShowLeftFade(hasOverflow && scrollLeft > 8);
    setShowRightFade(hasOverflow && scrollLeft < scrollWidth - clientWidth - 8);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateGradients();
    container.addEventListener("scroll", updateGradients, { passive: true });
    window.addEventListener("resize", updateGradients, { passive: true });

    return () => {
      container.removeEventListener("scroll", updateGradients);
      window.removeEventListener("resize", updateGradients);
    };
  }, [images, updateGradients]);

  if (images.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="hide-scrollbar-x flex gap-[8px] overflow-x-auto"
        style={{ paddingBottom: "2px" }}
      >
        {images.map((image) => (
          <div
            key={image.localId}
            className="group relative shrink-0 overflow-hidden rounded-[var(--radius-sm)]"
            style={{ width: dimension, height: dimension }}
          >
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={image.name ?? "Attached image"}
              className="size-full object-cover"
            />
            {(image.uploadState === "uploading" || image.uploadState === "pending") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-[4px] bg-black/40">
                <LoaderCircle className="size-5 animate-spin text-white" />
                {image.showSlowSpinner && (
                  <span className="text-[10px] text-white/80">Uploading...</span>
                )}
              </div>
            )}
            {image.uploadState === "failed" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] bg-black/40">
                <span className="text-xs text-red-400">Failed</span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(image.localId)}
                    className="flex items-center gap-[4px] rounded-full bg-red-500 px-[8px] py-[4px] text-[10px] text-white transition-opacity hover:opacity-80"
                    aria-label="Retry upload"
                  >
                    <RotateCw className="size-[10px]" />
                    Retry
                  </button>
                )}
              </div>
            )}
            {image.uploadState !== "failed" && (
              <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                <div className="absolute inset-0 bg-black/40" />
                <button
                  type="button"
                  onClick={() => onRemove(image.localId)}
                  className="relative z-10 flex h-[24px] w-[24px] items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
                  aria-label="Remove image"
                >
                  <X className="size-[14px]" strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {showLeftFade && (
        <div
          className="pointer-events-none absolute left-0 top-0 z-[1] w-[32px] bg-gradient-to-r from-[var(--bg-card)] to-transparent"
          style={{ height: dimension }}
        />
      )}
      {showRightFade && (
        <div
          className="pointer-events-none absolute right-0 top-0 z-[1] w-[32px] bg-gradient-to-l from-[var(--bg-card)] to-transparent"
          style={{ height: dimension }}
        />
      )}
    </div>
  );
}