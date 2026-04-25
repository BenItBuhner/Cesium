"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

interface ImagePreviewOverlayProps {
  open: boolean;
  onClose: () => void;
  imageSrc: string;
}

export function ImagePreviewOverlay({ open, onClose, imageSrc }: ImagePreviewOverlayProps) {
  const [zoom, setZoom] = useState(1);
  const [mounted, setMounted] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const clampZoom = useCallback((z: number) => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM), []);

  const zoomIn = useCallback(() => setZoom((z) => clampZoom(z + ZOOM_STEP)), [clampZoom]);
  const zoomOut = useCallback(() => setZoom((z) => clampZoom(z - ZOOM_STEP)), [clampZoom]);
  const zoomReset = useCallback(() => setZoom(1), []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setZoom(1);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((z) => clampZoom(z + delta));
    },
    [clampZoom],
  );

  useEffect(() => {
    if (!open) return;
    const container = imageContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [open, handleWheel]);

  if (!open || !mounted) return null;

  const showScroll = zoom > 1;

  const overlay = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[10050] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      <div
        className="absolute inset-0 bg-black/80"
        aria-hidden
        onPointerDown={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="pointer-events-auto absolute left-[16px] top-[16px] z-10 flex items-center gap-[6px] rounded-[8px] bg-black/60 px-[6px] py-[4px]">
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom >= MAX_ZOOM}
          className="flex h-[32px] w-[32px] items-center justify-center rounded-[4px] text-white/90 transition-colors hover:bg-white/15 disabled:text-white/30"
          aria-label="Zoom in"
        >
          <ZoomIn className="size-[18px]" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom <= MIN_ZOOM}
          className="flex h-[32px] w-[32px] items-center justify-center rounded-[4px] text-white/90 transition-colors hover:bg-white/15 disabled:text-white/30"
          aria-label="Zoom out"
        >
          <ZoomOut className="size-[18px]" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={zoomReset}
          className="flex h-[32px] w-[32px] items-center justify-center rounded-[4px] text-white/90 transition-colors hover:bg-white/15"
          aria-label="Reset zoom"
        >
          <Maximize2 className="size-[18px]" strokeWidth={1.75} />
        </button>
        <span className="min-w-[44px] text-center font-sans text-[12px] font-medium text-white/70">
          {Math.round(zoom * 100)}%
        </span>
      </div>
      <div className="pointer-events-auto absolute right-[16px] top-[16px] z-10 flex items-center gap-[6px] rounded-[8px] bg-black/60 px-[6px] py-[4px]">
        <button
          type="button"
          onClick={onClose}
          className="flex h-[32px] w-[32px] items-center justify-center rounded-[4px] text-white/90 transition-colors hover:bg-white/15"
          aria-label="Close preview"
        >
          <X className="size-[18px]" strokeWidth={2} />
        </button>
      </div>
      <div
        ref={imageContainerRef}
        className={`relative z-[1] flex items-center justify-center ${showScroll ? "overflow-auto" : "overflow-hidden"}`}
        style={{ width: "100vw", height: "100vh" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <img
          src={imageSrc}
          alt="Preview"
          draggable={false}
          className="max-w-none select-none"
          style={{
            transform: `scale(${zoom})`,
            transition: "transform 0.15s ease-out",
            maxWidth: zoom <= 1 ? "90vw" : undefined,
            maxHeight: zoom <= 1 ? "85vh" : undefined,
            objectFit: "contain",
          }}
        />
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
