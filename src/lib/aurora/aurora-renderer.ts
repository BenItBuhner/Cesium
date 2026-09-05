/**
 * Canvas renderer for the aurora conversation backdrop: wavy curtain bands of
 * soft color drifting across the pane, whose pace, brightness, and tint react
 * to the conversation lifecycle - calm ambient drift when idle, a lifted glow
 * near the composer while typing, energetic flow with a traveling shimmer
 * while the agent works, a slow amber breath while waiting on the user, a
 * bright mint bloom on completion, and a brief crimson wash on failure.
 *
 * Draws at a very low internal resolution (the element upscales + blurs via
 * CSS), so a frame is ~a hundred tiny sprite blits - cheap even at 30fps.
 */

export type AuroraMood =
  | "new-chat"
  | "idle"
  | "typing"
  | "working"
  | "waiting"
  | "completed"
  | "error"
  | "paused";

type Rgb = [number, number, number];

type MoodParams = {
  /** Horizontal drift / wave-phase speed multiplier. */
  flow: number;
  /** Wave amplitude multiplier. */
  energy: number;
  /** Overall alpha multiplier. */
  luminance: number;
  /** Strength of the up-welling glow behind the composer. */
  bottomGlow: number;
  /** 0..1 slow breathing of overall alpha. */
  pulse: number;
  /** 0..1 strength of the highlight traveling along the bands. */
  shimmer: number;
  /** Color washed into the bands (completion mint, error crimson, waiting amber). */
  tint: Rgb | null;
  tintStrength: number;
};

const MOOD_TARGETS: Record<AuroraMood, MoodParams> = {
  "new-chat": {
    flow: 0.55,
    energy: 0.95,
    luminance: 0.95,
    bottomGlow: 0.3,
    pulse: 0,
    shimmer: 0.25,
    tint: null,
    tintStrength: 0,
  },
  idle: {
    flow: 0.32,
    energy: 0.7,
    luminance: 0.6,
    bottomGlow: 0.12,
    pulse: 0,
    shimmer: 0.12,
    tint: null,
    tintStrength: 0,
  },
  typing: {
    flow: 0.5,
    energy: 0.8,
    luminance: 0.8,
    bottomGlow: 0.62,
    pulse: 0,
    shimmer: 0.2,
    tint: null,
    tintStrength: 0,
  },
  working: {
    flow: 1.7,
    energy: 1.25,
    luminance: 1.05,
    bottomGlow: 0.35,
    pulse: 0.12,
    shimmer: 1,
    tint: null,
    tintStrength: 0,
  },
  waiting: {
    flow: 0.45,
    energy: 0.75,
    luminance: 1.0,
    bottomGlow: 0.55,
    pulse: 0.85,
    shimmer: 0.2,
    tint: [251, 191, 36],
    tintStrength: 0.62,
  },
  completed: {
    flow: 0.75,
    energy: 0.95,
    luminance: 1.65,
    bottomGlow: 0.6,
    pulse: 0,
    shimmer: 0.5,
    tint: [167, 243, 208],
    tintStrength: 0.5,
  },
  // Full-strength tint: partial mixes against teal/green palettes cancel into
  // gray-brown mud, so the wash must effectively replace the band hues.
  error: {
    flow: 0.35,
    energy: 0.65,
    luminance: 1.1,
    bottomGlow: 0.5,
    pulse: 0.3,
    shimmer: 0.1,
    tint: [244, 63, 94],
    tintStrength: 1,
  },
  paused: {
    flow: 0.12,
    energy: 0.45,
    luminance: 0.34,
    bottomGlow: 0.08,
    pulse: 0,
    shimmer: 0,
    tint: null,
    tintStrength: 0,
  },
};

export type AuroraRendererOptions = {
  /** 0..100 from settings. */
  intensity: number;
  /** 0..100 from settings; 50 is the designed pace. */
  speed: number;
  /** Dark appearance draws brighter (screen-blended); light stays pastel. */
  isDark: boolean;
  /**
   * Sprite columns across the canvas width (default 22). Fewer, wider
   * columns blit fewer sprites per frame; under the blur the difference is
   * invisible, so hosts lower it on software rasterizers / low-power devices.
   */
  columns?: number;
};

const DEFAULT_COLUMNS = 22;

/** Resolved vertical placement of the aurora within the pane. */
export type AuroraPlacement = "top" | "center" | "full" | "bottom";

type PlacementParams = {
  /** Fraction of pane height where the band group centers. */
  centerY: number;
  /** Vertical spread of the band group (fraction of height). */
  spread: number;
  /** Gaussian sigma of the visibility window around `centerY`. */
  sigma: number;
  /** Minimum mask alpha outside the window (1 = no masking). */
  floor: number;
};

const PLACEMENT_TARGETS: Record<AuroraPlacement, PlacementParams> = {
  top: { centerY: 0.14, spread: 0.3, sigma: 0.3, floor: 0.04 },
  center: { centerY: 0.5, spread: 0.34, sigma: 0.28, floor: 0.04 },
  full: { centerY: 0.5, spread: 0.8, sigma: 0.85, floor: 0.55 },
  bottom: { centerY: 0.84, spread: 0.24, sigma: 0.26, floor: 0.03 },
};

function parseHexColor(hex: string): Rgb {
  const value = hex.replace("#", "");
  const num = Number.parseInt(value, 16);
  if (!Number.isFinite(num) || value.length !== 6) {
    return [56, 189, 248];
  }
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Soft radial sprite, cached per quantized color. Stamped stretched for curtains and glows. */
function makeSprite(rgb: Rgb): HTMLCanvasElement {
  const size = 128;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const ctx = sprite.getContext("2d");
  if (!ctx) {
    return sprite;
  }
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  const [r, g, b] = rgb.map(Math.round);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
  gradient.addColorStop(0.42, `rgba(${r}, ${g}, ${b}, 0.5)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}

type BandSpec = {
  color: Rgb;
  /** -0.5..0.5 position within the band group; scaled by placement spread. */
  offset: number;
  /** Wave phase offsets so bands never sync up. */
  phase: number;
  /** Alternating drift direction. */
  direction: 1 | -1;
  alpha: number;
};

function buildBands(colors: string[]): BandSpec[] {
  const parsed = colors.slice(0, 5).map(parseHexColor);
  while (parsed.length < 2) {
    parsed.push([139, 92, 246]);
  }
  const count = parsed.length;
  return parsed.map((color, index) => ({
    color,
    offset: count > 1 ? index / (count - 1) - 0.5 : 0,
    phase: index * 2.39996, // golden angle keeps the waves visually unrelated
    direction: index % 2 === 0 ? 1 : -1,
    alpha: 0.46 - index * 0.04,
  }));
}

const SMOOTH_ATTACK_TAU_MS = 450;
const SMOOTH_RELEASE_TAU_MS = 1500;

function approach(current: number, target: number, dtMs: number): number {
  const tau = Math.abs(target) > Math.abs(current) ? SMOOTH_ATTACK_TAU_MS : SMOOTH_RELEASE_TAU_MS;
  const k = 1 - Math.exp(-dtMs / tau);
  return current + (target - current) * k;
}

export type AuroraRenderer = {
  setMood(mood: AuroraMood): void;
  setPlacement(placement: AuroraPlacement): void;
  setPalette(colors: string[]): void;
  setOptions(options: AuroraRendererOptions): void;
  /** Advance the simulation and paint one frame. `dtMs` since the previous call. */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, dtMs: number): void;
  /** Jump smoothing to the current mood targets (first paint, reduced motion). */
  snapToMood(): void;
};

/** Wall-clock duration of a placement move (independent of the speed setting). */
const PLACEMENT_GLIDE_MS = 2000;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createAuroraRenderer(): AuroraRenderer {
  let mood: AuroraMood = "idle";
  let placement: AuroraPlacement = "top";
  let bands: BandSpec[] = buildBands(["#22e0a6", "#38bdf8", "#8b5cf6", "#d946ef"]);
  let options: AuroraRendererOptions = { intensity: 55, speed: 50, isDark: true };

  const params: MoodParams = { ...MOOD_TARGETS.idle, tint: null };
  const place: PlacementParams = { ...PLACEMENT_TARGETS.top };
  // Placement moves are timed against wall-clock progress rather than
  // per-frame smoothing: heavy work right at a move's start (e.g. mounting
  // the conversation view during the composer split) stalls frames, and a
  // frame-based approach would fast-forward the glide into a visible snap.
  let placeFrom: PlacementParams = { ...PLACEMENT_TARGETS.top };
  let placeTo: PlacementParams = { ...PLACEMENT_TARGETS.top };
  let placeStartMs = -PLACEMENT_GLIDE_MS;
  let realTimeMs = 0;
  let tintColor: Rgb = [255, 255, 255];

  /** Accumulated wave phase; scaling by flow/speed at accumulation time keeps changes seamless. */
  let flowTime = 12_000;
  let clockMs = 0;

  const spriteCache = new Map<string, HTMLCanvasElement>();
  let fadeGradient: CanvasGradient | null = null;
  let fadeGradientKey = "";
  const spriteFor = (rgb: Rgb): HTMLCanvasElement => {
    // Quantize so tint interpolation doesn't mint a sprite per frame.
    const key = rgb.map((v) => Math.round(v / 8) * 8).join(",");
    let sprite = spriteCache.get(key);
    if (!sprite) {
      if (spriteCache.size > 96) {
        spriteCache.clear();
      }
      sprite = makeSprite(rgb);
      spriteCache.set(key, sprite);
    }
    return sprite;
  };

  const speedMultiplier = (): number => {
    const normalized = options.speed / 50;
    return 0.1 + Math.pow(normalized, 1.35) * 0.9;
  };

  const step = (dtMs: number): void => {
    const target = MOOD_TARGETS[mood];
    params.flow = approach(params.flow, target.flow, dtMs);
    params.energy = approach(params.energy, target.energy, dtMs);
    params.luminance = approach(params.luminance, target.luminance, dtMs);
    params.bottomGlow = approach(params.bottomGlow, target.bottomGlow, dtMs);
    params.pulse = approach(params.pulse, target.pulse, dtMs);
    params.shimmer = approach(params.shimmer, target.shimmer, dtMs);
    params.tintStrength = approach(params.tintStrength, target.tintStrength, dtMs);
    if (target.tint) {
      tintColor = mixRgb(tintColor, target.tint, 1 - Math.exp(-dtMs / SMOOTH_ATTACK_TAU_MS));
    }
    realTimeMs += dtMs;
    const progress = Math.min(1, (realTimeMs - placeStartMs) / PLACEMENT_GLIDE_MS);
    const eased = easeInOutCubic(progress);
    place.centerY = placeFrom.centerY + (placeTo.centerY - placeFrom.centerY) * eased;
    place.spread = placeFrom.spread + (placeTo.spread - placeFrom.spread) * eased;
    place.sigma = placeFrom.sigma + (placeTo.sigma - placeFrom.sigma) * eased;
    place.floor = placeFrom.floor + (placeTo.floor - placeFrom.floor) * eased;
    const pace = speedMultiplier();
    flowTime += dtMs * params.flow * pace;
    clockMs += dtMs * pace;
  };

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    const intensityFactor = Math.pow(options.intensity / 100, 1.15) * (options.isDark ? 1 : 0.62);
    const breath = 1 + params.pulse * 0.3 * Math.sin(clockMs * 0.0016);
    const master = intensityFactor * params.luminance * breath;
    if (master <= 0.001) {
      return;
    }

    const t = flowTime;
    const columns = Math.max(4, options.columns ?? DEFAULT_COLUMNS);
    const stepX = Math.max(8, w / columns);
    const margin = stepX * 2;

    for (const [index, band] of bands.entries()) {
      const color = params.tintStrength > 0.01
        ? mixRgb(band.color, tintColor, Math.min(1, params.tintStrength) * 0.8)
        : band.color;
      const sprite = spriteFor(color);
      const dir = band.direction;
      const baseY = (place.centerY + band.offset * place.spread) * h;
      const amp1 = h * 0.075 * params.energy;
      const amp2 = h * 0.04 * params.energy;
      const k1 = (Math.PI * 2) / (w * (1.15 - index * 0.12));
      const k2 = (Math.PI * 2) / (w * 0.52);
      const drift = dir * t * 0.00023;
      // Traveling highlight: a gaussian window sweeping along the band.
      const shimmerCenter = ((t * 0.000045 + index * 0.37) % 1.4) - 0.2;

      for (let x = -margin; x <= w + margin; x += stepX) {
        const fx = x / w;
        const y =
          baseY +
          Math.sin(x * k1 + drift + band.phase) * amp1 +
          Math.sin(x * k2 - drift * 1.7 + band.phase * 1.3) * amp2;
        const envelope =
          0.62 + 0.38 * Math.sin(fx * 4.1 + t * 0.00019 * dir + band.phase * 2.1);
        const shimmerBoost =
          params.shimmer > 0.01
            ? Math.exp(-((fx - shimmerCenter) ** 2) / 0.012) * params.shimmer * 0.85
            : 0;
        const alpha = band.alpha * envelope * (1 + shimmerBoost) * master;
        if (alpha <= 0.004) {
          continue;
        }
        const sway = Math.sin(x * k2 * 0.7 + t * 0.00013 + band.phase) * 0.35;
        const sw = stepX * 3.1;
        const sh = sw * (1.65 + sway) * (0.9 + params.energy * 0.25);
        ctx.globalAlpha = Math.min(0.85, alpha);
        // Curtains hang downward from the ridge.
        ctx.drawImage(sprite, x - sw / 2, y - sh * 0.22, sw, sh);
      }
    }

    // Vertical visibility window: a gaussian centered on the placement keeps
    // the rest of the pane neutral so content has resting space. Full-pane
    // placement raises the floor so the mask nearly disappears. Applied
    // before the composer glow.
    ctx.globalCompositeOperation = "destination-in";
    ctx.globalAlpha = 1;
    // The mask only depends on the canvas height and the (slowly easing)
    // placement; rebuilding a 9-stop gradient every frame was pure churn
    // during the long stretches where placement is static.
    const fadeKey = `${h}|${place.centerY.toFixed(4)}|${place.sigma.toFixed(4)}|${place.floor.toFixed(4)}`;
    if (!fadeGradient || fadeGradientKey !== fadeKey) {
      const fade = ctx.createLinearGradient(0, 0, 0, h);
      const twoSigmaSq = 2 * place.sigma * place.sigma;
      for (let stop = 0; stop <= 8; stop += 1) {
        const y01 = stop / 8;
        const gauss = Math.exp(-((y01 - place.centerY) ** 2) / twoSigmaSq);
        const alpha = Math.min(1, place.floor + (1 - place.floor) * gauss);
        fade.addColorStop(y01, `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
      }
      fadeGradient = fade;
      fadeGradientKey = fadeKey;
    }
    ctx.fillStyle = fadeGradient;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    // Up-welling glow behind the composer; brightens while typing/waiting.
    if (params.bottomGlow > 0.015) {
      const glowColor = params.tintStrength > 0.01
        ? mixRgb(bands[0].color, tintColor, Math.min(1, params.tintStrength) * 0.8)
        : mixRgb(bands[0].color, bands[bands.length - 1].color, 0.35);
      const sprite = spriteFor(glowColor);
      const wander = Math.sin(t * 0.00011) * w * 0.08;
      const gw = w * 1.3;
      const gh = h * 0.5;
      ctx.globalAlpha = Math.min(0.55, params.bottomGlow * master * 0.5);
      ctx.drawImage(sprite, w / 2 - gw / 2 + wander, h - gh * 0.3, gw, gh);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };

  return {
    setMood(next) {
      mood = next;
    },
    setPlacement(next) {
      if (next === placement) {
        return;
      }
      placement = next;
      placeFrom = { ...place };
      placeTo = { ...PLACEMENT_TARGETS[next] };
      placeStartMs = realTimeMs;
    },
    setPalette(colors) {
      bands = buildBands(colors);
    },
    setOptions(next) {
      options = next;
    },
    snapToMood() {
      const target = MOOD_TARGETS[mood];
      params.flow = target.flow;
      params.energy = target.energy;
      params.luminance = target.luminance;
      params.bottomGlow = target.bottomGlow;
      params.pulse = target.pulse;
      params.shimmer = target.shimmer;
      params.tintStrength = target.tintStrength;
      if (target.tint) {
        tintColor = target.tint;
      }
      const placeTarget = PLACEMENT_TARGETS[placement];
      place.centerY = placeTarget.centerY;
      place.spread = placeTarget.spread;
      place.sigma = placeTarget.sigma;
      place.floor = placeTarget.floor;
      placeFrom = { ...placeTarget };
      placeTo = { ...placeTarget };
      placeStartMs = realTimeMs - PLACEMENT_GLIDE_MS;
    },
    render(ctx, width, height, dtMs) {
      step(Math.min(120, Math.max(0, dtMs)));
      draw(ctx, width, height);
    },
  };
}
