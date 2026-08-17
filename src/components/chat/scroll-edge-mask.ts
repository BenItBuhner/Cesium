import type { CSSProperties } from "react";

export type ScrollEdgeFadeState = {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
};

export type ScrollEdgeMaskOptions = {
  size?: number | string;
  topSize?: number | string;
  rightSize?: number | string;
  bottomSize?: number | string;
  leftSize?: number | string;
};

type MaskStyle = CSSProperties & {
  WebkitMaskComposite?: string;
};

function cssLength(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

function verticalMask(
  top: boolean,
  bottom: boolean,
  topSize: string,
  bottomSize: string
): string | null {
  if (top && bottom) {
    return `linear-gradient(to bottom, transparent 0, black ${topSize}, black calc(100% - ${bottomSize}), transparent 100%)`;
  }
  if (top) {
    return `linear-gradient(to bottom, transparent 0, black ${topSize})`;
  }
  if (bottom) {
    return `linear-gradient(to bottom, black calc(100% - ${bottomSize}), transparent 100%)`;
  }
  return null;
}

function horizontalMask(
  left: boolean,
  right: boolean,
  leftSize: string,
  rightSize: string
): string | null {
  if (left && right) {
    return `linear-gradient(to right, transparent 0, black ${leftSize}, black calc(100% - ${rightSize}), transparent 100%)`;
  }
  if (left) {
    return `linear-gradient(to right, transparent 0, black ${leftSize})`;
  }
  if (right) {
    return `linear-gradient(to right, black calc(100% - ${rightSize}), transparent 100%)`;
  }
  return null;
}

/**
 * Fades the scrollport itself instead of painting a theme-colored layer above
 * it. Mask colors represent alpha only, so animated, translucent, and custom
 * backgrounds continue to show through unchanged.
 */
export function scrollEdgeMaskStyle(
  fade: ScrollEdgeFadeState,
  options: ScrollEdgeMaskOptions = {}
): MaskStyle {
  const defaultSize = cssLength(options.size ?? 24);
  const topSize = cssLength(options.topSize ?? defaultSize);
  const rightSize = cssLength(options.rightSize ?? defaultSize);
  const bottomSize = cssLength(options.bottomSize ?? defaultSize);
  const leftSize = cssLength(options.leftSize ?? defaultSize);
  const masks = [
    verticalMask(Boolean(fade.top), Boolean(fade.bottom), topSize, bottomSize),
    horizontalMask(Boolean(fade.left), Boolean(fade.right), leftSize, rightSize),
  ].filter((mask): mask is string => mask !== null);

  if (masks.length === 0) {
    return {};
  }

  const maskImage = masks.join(", ");
  const composite =
    masks.length > 1
      ? {
          maskComposite: "intersect" as CSSProperties["maskComposite"],
          WebkitMaskComposite: "source-in",
        }
      : {};

  return {
    maskImage,
    WebkitMaskImage: maskImage,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    ...composite,
  };
}
