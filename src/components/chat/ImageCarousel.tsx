import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCw, X } from "lucide-react";
import type { ImageAttachmentState } from "@/lib/types";
import { ImagePreviewOverlay } from "./ImagePreviewOverlay";
import {
  attachmentFileKind,
  formatAttachmentSize,
} from "./attachment-file-kind";

interface ImageCarouselProps {
  images: ImageAttachmentState[];
  onRemove?: (localId: string) => void;
  onRetry?: (localId: string) => void;
  size?: "compact" | "expanded";
  readOnly?: boolean;
}

const THUMBNAIL_SIZE = {
  compact: 64,
  expanded: 80,
};

const FILE_CARD_WIDTH = {
  compact: 172,
  expanded: 200,
};

/** Image tiles show pixels; everything else renders as a typed file card. */
function isImageEntry(attachment: ImageAttachmentState): boolean {
  if (attachment.kind === "file") return false;
  return attachment.mimeType.startsWith("image/");
}

export function ImageCarousel({ images, onRemove, onRetry, size = "compact", readOnly = false }: ImageCarouselProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const [previewImage, setPreviewImage] = useState<ImageAttachmentState | null>(null);
  const dimension = THUMBNAIL_SIZE[size];
  const fileCardWidth = FILE_CARD_WIDTH[size];

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

  const renderOverlays = (attachment: ImageAttachmentState) => (
    <>
      {(attachment.uploadState === "uploading" || attachment.uploadState === "pending") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[4px] rounded-[inherit] bg-black/40">
          <LoaderCircle className="size-5 animate-spin text-white" />
          {attachment.showSlowSpinner && (
            <span className="text-[10px] text-white/80">Uploading...</span>
          )}
        </div>
      )}
      {!readOnly && attachment.uploadState === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] rounded-[inherit] bg-black/40">
          <span className="text-xs text-red-400">Failed</span>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(attachment.localId)}
              className="flex items-center gap-[4px] rounded-full bg-red-500 px-[8px] py-[4px] text-[10px] text-white transition-opacity hover:opacity-80"
              aria-label="Retry upload"
            >
              <RotateCw className="size-[10px]" />
              Retry
            </button>
          )}
        </div>
      )}
      {!readOnly && attachment.uploadState !== "failed" && onRemove && (
        <div className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity group-hover:opacity-100">
          <div className="absolute inset-0 rounded-[inherit] bg-black/40" />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(attachment.localId);
            }}
            className="pointer-events-auto absolute right-[4px] top-[4px] z-10 flex h-[22px] w-[22px] items-center justify-center rounded-[4px] bg-black/50 text-white transition-colors hover:bg-black/70"
            aria-label="Remove attachment"
          >
            <X className="size-[14px]" strokeWidth={2} />
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="hide-scrollbar-x flex gap-[8px] overflow-x-auto"
        style={{ paddingBottom: "2px" }}
      >
      {images.map((attachment) => {
        if (isImageEntry(attachment)) {
          return (
            <div
              key={attachment.localId}
              className="group relative shrink-0 overflow-hidden rounded-[var(--radius-sm)]"
              style={{ width: dimension, height: dimension }}
            >
              <img
                src={`data:${attachment.mimeType};base64,${attachment.data}`}
                alt={attachment.name ?? "Attached image"}
                className="size-full cursor-pointer object-cover"
                onClick={() => setPreviewImage(attachment)}
              />
              {renderOverlays(attachment)}
            </div>
          );
        }
        const kind = attachmentFileKind(attachment.name, attachment.mimeType);
        const caption = [
          kind.badge,
          typeof attachment.size === "number" && attachment.size >= 0
            ? formatAttachmentSize(attachment.size)
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={attachment.localId}
            className="group relative flex shrink-0 items-center gap-[8px] rounded-[var(--radius-sm)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px]"
            style={{ width: fileCardWidth, height: dimension }}
            title={attachment.name}
          >
            <div
              className="flex size-[34px] shrink-0 items-center justify-center rounded-[8px]"
              style={{ backgroundColor: `${kind.color}1f`, color: kind.color }}
            >
              <kind.Icon className="size-[18px]" strokeWidth={1.6} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11.5px] font-medium leading-[15px] text-[var(--text-primary)]">
                {attachment.name ?? "Attached file"}
              </div>
              <div className="truncate text-[10px] leading-[14px] text-[var(--text-secondary)]">
                {caption || "File"}
              </div>
            </div>
            {renderOverlays(attachment)}
          </div>
        );
      })}
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
      {previewImage && (
        <ImagePreviewOverlay
          open
          onClose={() => setPreviewImage(null)}
          imageSrc={`data:${previewImage.mimeType};base64,${previewImage.data}`}
        />
      )}
    </div>
  );
}
