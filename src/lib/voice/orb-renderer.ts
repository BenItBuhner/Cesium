/**
 * Canvas renderer for the ambient voice orb: a soft, cloudy sphere whose
 * internal weather reacts to the voice lifecycle - slow drift when idle,
 * level-reactive swell while hearing the user, a faster churn while
 * thinking, and amplitude-synced pulsing while speaking.
 */

export type OrbActivity =
  | "idle"
  | "listening"
  | "capturing"
  | "transcribing"
  | "thinking"
  | "speaking";

export type OrbRenderState = {
  activity: OrbActivity;
  /** off | paused dim the orb; quiet slightly cools it. */
  mode: "off" | "active" | "quiet" | "paused";
  /** 0..1 - mic level while listening/capturing, TTS output while speaking. */
  level: number;
  timeMs: number;
};

type CloudSpec = {
  orbitRadius: number;
  orbitSpeed: number;
  phase: number;
  size: number;
  alpha: number;
};

const CLOUDS: CloudSpec[] = [
  { orbitRadius: 0.30, orbitSpeed: 0.00011, phase: 0.0, size: 0.68, alpha: 0.55 },
  { orbitRadius: 0.22, orbitSpeed: -0.00017, phase: 2.1, size: 0.55, alpha: 0.45 },
  { orbitRadius: 0.34, orbitSpeed: 0.00008, phase: 4.2, size: 0.48, alpha: 0.38 },
  { orbitRadius: 0.16, orbitSpeed: 0.00023, phase: 1.2, size: 0.4, alpha: 0.3 },
];

function activityParams(state: OrbRenderState): {
  speedMultiplier: number;
  turbulence: number;
  swell: number;
  brightness: number;
} {
  const level = Math.min(1, Math.max(0, state.level));
  switch (state.activity) {
    case "capturing":
      return {
        speedMultiplier: 2.2,
        turbulence: 0.5 + level * 0.8,
        swell: 0.02 + level * 0.09,
        brightness: 1.04,
      };
    case "listening":
      return {
        speedMultiplier: 1.3,
        turbulence: 0.35 + level * 0.3,
        swell: 0.012 + level * 0.03,
        brightness: 1.0,
      };
    case "transcribing":
    case "thinking":
      return { speedMultiplier: 4.5, turbulence: 0.9, swell: 0.015, brightness: 0.97 };
    case "speaking":
      return {
        speedMultiplier: 1.8,
        turbulence: 0.55,
        swell: 0.015 + level * 0.1,
        brightness: 1.07 + level * 0.06,
      };
    default:
      return { speedMultiplier: 1, turbulence: 0.3, swell: 0.01, brightness: 1 };
  }
}

export function drawOrb(
  ctx: CanvasRenderingContext2D,
  cssSize: number,
  state: OrbRenderState
): void {
  const dpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const size = cssSize * dpr;
  ctx.save();
  ctx.clearRect(0, 0, size, size);

  const { speedMultiplier, turbulence, swell, brightness } =
    activityParams(state);
  const dimmed = state.mode === "off" || state.mode === "paused";
  const t = state.timeMs;
  const center = size / 2;
  const breathe =
    Math.sin(t * 0.0011) * 0.008 + Math.sin(t * 0.0023 + 1.4) * 0.005;
  const radius = center * 0.92 * (1 + breathe + swell);

  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.clip();

  // Base sphere: bright cloudlight from below, like the reference orb.
  const base = ctx.createRadialGradient(
    center,
    center + radius * 0.45,
    radius * 0.1,
    center,
    center,
    radius * 1.05
  );
  const lift = dimmed ? 0.55 : Math.min(1.15, brightness);
  base.addColorStop(0, `rgba(${252 * lift}, ${252 * lift}, ${253 * lift}, 1)`);
  base.addColorStop(0.62, `rgba(${232 * lift}, ${233 * lift}, ${236 * lift}, 1)`);
  base.addColorStop(1, `rgba(${205 * lift}, ${207 * lift}, ${212 * lift}, 1)`);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Drifting cloud masses (dark, top-weighted like the reference).
  for (const [index, cloud] of CLOUDS.entries()) {
    const angle = t * cloud.orbitSpeed * speedMultiplier + cloud.phase;
    const wobble =
      Math.sin(t * 0.0007 * speedMultiplier + cloud.phase * 3) * turbulence;
    const cx =
      center + Math.cos(angle) * radius * cloud.orbitRadius * (1 + wobble * 0.3);
    const cy =
      center +
      Math.sin(angle * 1.3) * radius * cloud.orbitRadius * 0.8 -
      radius * 0.18 +
      wobble * radius * 0.06;
    const cloudRadius = radius * cloud.size * (1 + wobble * 0.12);
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cloudRadius);
    const darkness = dimmed ? 0.5 : 1;
    const alpha = cloud.alpha * darkness * (index === 0 ? 1 : turbulence + 0.55);
    gradient.addColorStop(0, `rgba(58, 62, 70, ${alpha})`);
    gradient.addColorStop(0.6, `rgba(90, 95, 104, ${alpha * 0.5})`);
    gradient.addColorStop(1, "rgba(120, 124, 132, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  // Bright underglow.
  const glow = ctx.createRadialGradient(
    center,
    center + radius * 0.55,
    0,
    center,
    center + radius * 0.55,
    radius * 0.9
  );
  glow.addColorStop(0, `rgba(255, 255, 255, ${dimmed ? 0.25 : 0.55})`);
  glow.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Rim shading for depth.
  const rim = ctx.createRadialGradient(
    center,
    center,
    radius * 0.72,
    center,
    center,
    radius
  );
  rim.addColorStop(0, "rgba(0, 0, 0, 0)");
  rim.addColorStop(1, `rgba(30, 32, 38, ${dimmed ? 0.3 : 0.18})`);
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  ctx.restore();
}
