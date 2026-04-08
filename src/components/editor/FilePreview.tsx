"use client";

import { useMemo } from "react";
import { buildAuthenticatedUrl } from "@/lib/auth-client";
import { getServerBaseUrl } from "@/lib/server-api";

interface FilePreviewProps {
  filePath: string;
  name: string;
  previewPath: string;
  mimeType?: string;
}

function toPreviewUrl(previewPath: string): string {
  if (/^https?:\/\//i.test(previewPath)) {
    return buildAuthenticatedUrl(previewPath);
  }
  return buildAuthenticatedUrl(`${getServerBaseUrl()}${previewPath}`);
}

export function FilePreview({
  filePath,
  name,
  previewPath,
  mimeType,
}: FilePreviewProps) {
  const src = useMemo(() => toPreviewUrl(previewPath), [previewPath]);
  const checkerboardStyle = useMemo(
    () => ({
      backgroundImage: [
        "linear-gradient(45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%)",
        "linear-gradient(-45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%)",
        "linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%)",
        "linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%)",
      ].join(", "),
      backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0",
      backgroundSize: "20px 20px",
    }),
    []
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-main)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2 font-sans text-[12px] text-[var(--text-secondary)]">
        <span className="truncate">{filePath}</span>
        <span className="shrink-0">{mimeType ?? "Preview"}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" style={checkerboardStyle}>
        <div className="flex min-h-full min-w-full items-start justify-center p-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- dynamic preview URLs; next/image needs width/height */}
          <img
            src={src}
            alt={name}
            className="h-auto max-w-none rounded-[10px] border border-[var(--border-card)] bg-white shadow-[0_18px_40px_rgba(0,0,0,0.18)]"
            loading="lazy"
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
