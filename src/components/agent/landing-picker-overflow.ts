"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * At or below this available width the row is treated as a mobile-friendly
 * layout: the Import pill is always hidden, regardless of whether the full
 * row would technically fit.
 *
 * Matches the narrow-pane convention used elsewhere in the agent shell
 * (centered content gutter drops at ≤640px; the composer force-compacts its
 * inline mode/model controls at the same width).
 */
export const LANDING_PICKER_MOBILE_MAX_WIDTH_PX = 640;

/**
 * Progressive condensation applied to the new-chat landing picker row
 * (workspace → branch → device → import) so it never wraps to a second line:
 *
 * - 0: everything full size (all labels, Import visible).
 * - 1: Import hidden.
 * - 2: Import hidden + device pill icon-only.
 * - 3: Import hidden + device and branch pills icon-only.
 */
export type LandingPickerCondenseTier = 0 | 1 | 2 | 3;

/**
 * Picks the smallest condensation tier whose probe row fits the available
 * width. Probes always render at full (uncondensed-for-that-tier) size, so
 * condensing the live row never feeds back into the measurement and the
 * layout cannot oscillate at a boundary.
 */
export function resolveLandingPickerCondenseTier(input: {
  /** Width available to the picker row; `null` until first layout pass. */
  availableWidthPx: number | null;
  /** Natural width of the full row (all labels + Import). */
  fullRowWidthPx: number | null;
  /** Natural width of the row without Import. */
  noImportRowWidthPx: number | null;
  /** Natural width of the row without Import and with an icon-only device pill. */
  condensedDeviceRowWidthPx: number | null;
}): LandingPickerCondenseTier {
  const available = input.availableWidthPx;
  if (typeof available !== "number" || !Number.isFinite(available) || available <= 0) {
    return 0;
  }
  // +1px tolerance absorbs sub-pixel rounding at the exact boundary.
  const fits = (probeWidth: number | null) =>
    typeof probeWidth === "number" &&
    Number.isFinite(probeWidth) &&
    probeWidth <= available + 1;

  const mobile = available <= LANDING_PICKER_MOBILE_MAX_WIDTH_PX;
  if (!mobile && fits(input.fullRowWidthPx)) {
    return 0;
  }
  if (fits(input.noImportRowWidthPx)) {
    return 1;
  }
  if (fits(input.condensedDeviceRowWidthPx)) {
    return 2;
  }
  return 3;
}

/**
 * Measures the available row width plus the natural widths of three hidden
 * probe rows (full, no-import, no-import + icon-only device) and resolves
 * the condensation tier for the live picker row. Re-measures on any resize
 * of the container or probes (labels changing length resize the probes).
 */
export function useLandingPickerCondenseTier(
  containerRef: RefObject<HTMLElement | null>,
  fullProbeRef: RefObject<HTMLElement | null>,
  noImportProbeRef: RefObject<HTMLElement | null>,
  condensedDeviceProbeRef: RefObject<HTMLElement | null>
): LandingPickerCondenseTier {
  const [tier, setTier] = useState<LandingPickerCondenseTier>(0);

  // Layout effect so the first measurement lands before paint - otherwise a
  // narrow pane briefly flashes the full-size row (with Import) on mount.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const fullProbe = fullProbeRef.current;
    const noImportProbe = noImportProbeRef.current;
    const condensedDeviceProbe = condensedDeviceProbeRef.current;
    if (!container || !fullProbe || !noImportProbe || !condensedDeviceProbe) {
      return;
    }

    const update = () => {
      setTier(
        resolveLandingPickerCondenseTier({
          availableWidthPx: container.clientWidth,
          fullRowWidthPx: fullProbe.scrollWidth,
          noImportRowWidthPx: noImportProbe.scrollWidth,
          condensedDeviceRowWidthPx: condensedDeviceProbe.scrollWidth,
        })
      );
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(fullProbe);
    observer.observe(noImportProbe);
    observer.observe(condensedDeviceProbe);

    return () => {
      observer.disconnect();
    };
  }, [containerRef, fullProbeRef, noImportProbeRef, condensedDeviceProbeRef]);

  return tier;
}
