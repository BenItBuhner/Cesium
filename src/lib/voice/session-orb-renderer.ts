/**
 * Canvas renderer for the revamped voice-agent session orb: a luminous core
 * with a slow-orbiting aurora ribbon, wrapped in level-reactive halo rings.
 * Each session state has its own color identity so the orb reads at a glance:
 *
 *   idle         dim neutral drift
 *   listening    cool cyan breathing
 *   capturing    bright teal swell synced to mic level
 *   transcribing violet fast churn
 *   sending      violet fast churn (agent is being prompted)
 *   working      deep indigo steady churn (agent turn running in the thread)
 *   speaking     warm amber pulse synced to TTS output level
 */

export type SessionOrbStatus =
  | "idle"
  | "listening"
  | "capturing"
  | "transcribing"
  | "sending"
  | "working"
  | "speaking";

export type SessionOrbRenderState = {
  status: SessionOrbStatus;
  /** 0..1 — mic level while listening/capturing, TTS level while speaking. */
  level: number;
  timeMs: number;
};

type Rgb = [number, number, number];

type StatusTheme = {
  core: Rgb;
  ribbon: Rgb;
  halo: Rgb;
  churn: number;
  swell: number;
  glow: number;
};

const THEMES: Record<SessionOrbStatus, StatusTheme> = {
  idle: {
    core: [148, 155, 170],
    ribbon: [96, 104, 122],
    halo: [120, 128, 146],
    churn: 0.55,
    swell: 0.008,
    glow: 0.28,
  },
  listening: {
    core: [116, 196, 236],
    ribbon: [66, 132, 210],
    halo: [96, 174, 228],
    churn: 1,
    swell: 0.02,
    glow: 0.5,
  },
  capturing: {
    core: [92, 226, 202],
    ribbon: [46, 168, 176],
    halo: [80, 214, 196],
    churn: 1.7,
    swell: 0.05,
    glow: 0.72,
  },
  transcribing: {
    core: [178, 148, 250],
    ribbon: [124, 92, 226],
    halo: [156, 128, 240],
    churn: 3.2,
    swell: 0.02,
    glow: 0.62,
  },
  sending: {
    core: [178, 148, 250],
    ribbon: [124, 92, 226],
    halo: [156, 128, 240],
    churn: 3.9,
    swell: 0.02,
    glow: 0.66,
  },
  working: {
    core: [138, 152, 244],
    ribbon: [92, 106, 214],
    halo: [120, 136, 236],
    churn: 2.2,
    swell: 0.016,
    glow: 0.58,
  },
  speaking: {
    core: [250, 196, 122],
    ribbon: [226, 142, 66],
    halo: [244, 178, 104],
    churn: 1.5,
    swell: 0.03,
    glow: 0.74,
  },
};

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

export function drawSessionOrb(
  ctx: CanvasRenderingContext2D,
  cssSize: number,
  state: SessionOrbRenderState
): void {
  const dpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const size = cssSize * dpr;
  const theme = THEMES[state.status] ?? THEMES.idle;
  const level = Math.min(1, Math.max(0, state.level));
  const t = state.timeMs;
  const center = size / 2;

  ctx.save();
  ctx.clearRect(0, 0, size, size);

  const breathe =
    Math.sin(t * 0.0012) * 0.01 + Math.sin(t * 0.0027 + 1.1) * 0.006;
  const coreRadius =
    center * 0.56 * (1 + breathe + theme.swell + level * 0.12);

  // Level-reactive halo rings around the core.
  for (let ring = 0; ring < 3; ring++) {
    const ringPhase = t * 0.0016 * theme.churn + ring * 2.1;
    const ringLevel = level * (1 - ring * 0.28);
    const ringRadius =
      coreRadius *
      (1.24 + ring * 0.24 + Math.sin(ringPhase) * 0.035 + ringLevel * 0.22);
    if (ringRadius >= center) continue;
    const ringAlpha =
      (0.16 - ring * 0.045 + ringLevel * 0.2) *
      (state.status === "idle" ? 0.5 : 1);
    ctx.beginPath();
    ctx.arc(center, center, ringRadius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, size * (0.006 - ring * 0.0012));
    ctx.strokeStyle = rgba(theme.halo, Math.max(0, ringAlpha));
    ctx.stroke();
  }

  // Ambient glow behind the core.
  const glow = ctx.createRadialGradient(
    center,
    center,
    coreRadius * 0.2,
    center,
    center,
    Math.min(center, coreRadius * 2.1)
  );
  glow.addColorStop(0, rgba(theme.core, theme.glow * (0.5 + level * 0.5)));
  glow.addColorStop(1, rgba(theme.core, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Core sphere.
  ctx.beginPath();
  ctx.arc(center, center, coreRadius, 0, Math.PI * 2);
  ctx.clip();

  const base = ctx.createRadialGradient(
    center - coreRadius * 0.28,
    center - coreRadius * 0.32,
    coreRadius * 0.08,
    center,
    center,
    coreRadius * 1.12
  );
  base.addColorStop(0, "rgba(252, 253, 255, 0.98)");
  base.addColorStop(0.42, rgba(theme.core, 0.92));
  base.addColorStop(1, rgba(theme.ribbon, 0.96));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Aurora ribbon: three orbiting energy blobs inside the core.
  for (let blob = 0; blob < 3; blob++) {
    const angle = t * 0.00042 * theme.churn * (blob % 2 === 0 ? 1 : -1.35) + blob * 2.4;
    const wobble = Math.sin(t * 0.0011 * theme.churn + blob * 1.7);
    const bx = center + Math.cos(angle) * coreRadius * (0.34 + wobble * 0.08);
    const by = center + Math.sin(angle * 1.22) * coreRadius * (0.3 + wobble * 0.06);
    const blobRadius = coreRadius * (0.5 + blob * 0.12 + level * 0.1);
    const blobGradient = ctx.createRadialGradient(bx, by, 0, bx, by, blobRadius);
    blobGradient.addColorStop(0, rgba(theme.ribbon, 0.5 + level * 0.25));
    blobGradient.addColorStop(0.65, rgba(theme.ribbon, 0.18));
    blobGradient.addColorStop(1, rgba(theme.ribbon, 0));
    ctx.fillStyle = blobGradient;
    ctx.fillRect(0, 0, size, size);
  }

  // Specular highlight and rim shading for depth.
  const highlight = ctx.createRadialGradient(
    center - coreRadius * 0.36,
    center - coreRadius * 0.42,
    0,
    center - coreRadius * 0.36,
    center - coreRadius * 0.42,
    coreRadius * 0.8
  );
  highlight.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  highlight.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = highlight;
  ctx.fillRect(0, 0, size, size);

  const rim = ctx.createRadialGradient(
    center,
    center,
    coreRadius * 0.7,
    center,
    center,
    coreRadius
  );
  rim.addColorStop(0, "rgba(0, 0, 0, 0)");
  rim.addColorStop(1, "rgba(12, 16, 26, 0.32)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  ctx.restore();
}
