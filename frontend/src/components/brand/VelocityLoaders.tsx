import { useEffect } from "react";

/* ─── SVG-asset loaders (from /public/loader-*.svg) ─────────────────────────
   These reference the static SVG animations shipped with the build.
   Use them for prominent full-page or section-level loading states.
   Sizes are multiples of the native 96×96 viewBox.
──────────────────────────────────────────────────────────────────────────── */

export function SvgVDrawLoader({ size = 96 }: { size?: number }) {
  return <img src="/loader-cascade.svg" width={size} height={size} alt="Loading…" role="status" aria-live="polite" />;
}

export function SvgSprintScanLoader({ size = 96 }: { size?: number }) {
  return <img src="/loader-velocity-bars.svg" width={size} height={size} alt="Loading…" role="status" aria-live="polite" />;
}

export function SvgTerminalLoader({ size = 96 }: { size?: number }) {
  return <img src="/loader-sprint-scan.svg" width={size} height={size} alt="Loading…" role="status" aria-live="polite" />;
}

export function SvgOrbitLoader({ size = 96 }: { size?: number }) {
  return <img src="/loader-orbit.svg" width={size} height={size} alt="Loading…" role="status" aria-live="polite" />;
}

export function SvgVelocityBarsLoader({ size = 96 }: { size?: number }) {
  return <img src="/loader-v-draw.svg" width={size} height={size} alt="Loading…" role="status" aria-live="polite" />;
}

/*
  All loaders use CSS custom properties only:
  --color-primary, --color-primary-end, --color-accent-cyan, --color-background
  NOTE: Do NOT replace skeleton/animate-pulse/shimmer loaders — only non-skeleton states.
*/

const LOADER_CSS = `
@keyframes vl-draw { 0% { stroke-dashoffset: 300 } 100% { stroke-dashoffset: 0 } }
@keyframes vl-scan { 0%,100%{top:8px;opacity:0} 20%{opacity:1} 80%{opacity:1} 99%{top:calc(100% - 10px);opacity:0} }
@keyframes vl-orbit { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
@keyframes vl-bar { 0%,100%{transform:scaleY(0.15)} 50%{transform:scaleY(1)} }
@keyframes vl-dot { 0%,100%{opacity:0.15} 33%{opacity:1} }
@keyframes vl-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.35;transform:scale(0.82)} }
@keyframes vl-glitch-r { 0%,85%,100%{opacity:0;transform:translateX(0)} 86%{opacity:0.6;transform:translateX(4px)} 88%{opacity:0.4;transform:translateX(-3px)} 90%{opacity:0} }
@keyframes vl-glitch-b { 0%,85%,100%{opacity:0;transform:translateX(0)} 87%{opacity:0.5;transform:translateX(-4px)} 89%{opacity:0.3;transform:translateX(3px)} 90%{opacity:0} }
`;

function injectCSS() {
  if (typeof document === "undefined") return;
  if (document.getElementById("velocity-loader-css")) return;
  const s = document.createElement("style");
  s.id = "velocity-loader-css";
  s.textContent = LOADER_CSS;
  document.head.appendChild(s);
}

/** Route transitions, Suspense fallback */
export function VDrawLoader({ size = 48 }: { size?: number }) {
  useEffect(() => { injectCSS(); }, []);
  const s = size;
  const cx = s / 2;
  const topY = s * 0.22;
  const midY = s * 0.68;
  const tipY = s * 0.82;
  const innerX = s * 0.18;
  const sw = Math.max(2, s * 0.075);
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" aria-label="Loading…" role="status">
      <defs>
        <linearGradient id="vl-draw-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-primary,#6366f1)" />
          <stop offset="100%" stopColor="var(--color-primary-end,#8b5cf6)" />
        </linearGradient>
      </defs>
      <path d={`M${s*0.08} ${topY} L${cx} ${tipY} L${s*0.92} ${topY}`} stroke="url(#vl-draw-g)" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.18} />
      <path d={`M${innerX} ${topY} L${cx} ${midY} L${s-innerX} ${topY}`} stroke="url(#vl-draw-g)" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" strokeDasharray={300} style={{ animation: "vl-draw 1.2s ease-in-out infinite alternate" }} />
      <circle cx={cx} cy={midY} r={Math.max(1.5, s*0.04)} fill="var(--color-accent-cyan,#a5f3fc)" style={{ animation: "vl-pulse 1.2s ease-in-out infinite" }} />
    </svg>
  );
}

/** Dashboard data loading, run results */
export function SprintScanLoader({ size = 48 }: { size?: number }) {
  useEffect(() => { injectCSS(); }, []);
  const s = size;
  const barH = Math.max(4, s * 0.1);
  const barW = s * 0.7;
  const x0 = s * 0.15;
  const gaps = [s*0.14, s*0.42, s*0.7];
  return (
    <div style={{ position: "relative", width: s, height: s, display: "flex", alignItems: "center", justifyContent: "center" }} role="status" aria-label="Loading…">
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <defs>
          <linearGradient id="vl-scan-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-primary,#6366f1)" />
            <stop offset="100%" stopColor="var(--color-primary-end,#8b5cf6)" />
          </linearGradient>
        </defs>
        {gaps.map((y, i) => (
          <rect key={i} x={x0} y={y} width={barW} height={barH} rx={2} fill="url(#vl-scan-g)" opacity={[0.85, 0.55, 0.3][i]} />
        ))}
      </svg>
      <div style={{ position: "absolute", left: `${s*0.15}px`, right: `${s*0.15}px`, height: 2, background: "linear-gradient(90deg, transparent, var(--color-accent-cyan,#a5f3fc), transparent)", boxShadow: "0 0 8px var(--color-accent-cyan,#a5f3fc)", animation: "vl-scan 1.4s ease-in-out infinite" }} />
    </div>
  );
}

/** Modals, drawers, AI analysis */
export function QuantumOrbitLoader({ size = 48 }: { size?: number }) {
  useEffect(() => { injectCSS(); }, []);
  const s = size;
  const cx = s / 2;
  const rx = s * 0.42;
  const ry = s * 0.14;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" role="status" aria-label="Loading…">
      <defs>
        <linearGradient id="vl-orbit-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-primary,#6366f1)" />
          <stop offset="100%" stopColor="var(--color-primary-end,#8b5cf6)" />
        </linearGradient>
      </defs>
      <ellipse cx={cx} cy={cx} rx={rx} ry={ry} stroke="url(#vl-orbit-g)" strokeWidth={Math.max(0.8,s*0.015)} fill="none" opacity={0.5} />
      <ellipse cx={cx} cy={cx} rx={rx} ry={ry} stroke="url(#vl-orbit-g)" strokeWidth={Math.max(0.7,s*0.012)} fill="none" opacity={0.3} transform={`rotate(60 ${cx} ${cx})`} />
      <ellipse cx={cx} cy={cx} rx={rx} ry={ry} stroke="url(#vl-orbit-g)" strokeWidth={Math.max(0.7,s*0.012)} fill="none" opacity={0.3} transform={`rotate(120 ${cx} ${cx})`} />
      <g style={{ transformOrigin: `${cx}px ${cx}px`, animation: "vl-orbit 2s linear infinite" }}>
        <circle cx={cx + rx} cy={cx} r={Math.max(2,s*0.06)} fill="var(--color-accent-cyan,#a5f3fc)" />
      </g>
      <circle cx={cx} cy={cx} r={s*0.13} fill="var(--color-background,#020617)" stroke="url(#vl-orbit-g)" strokeWidth={Math.max(1,s*0.02)} />
      <circle cx={cx} cy={cx} r={s*0.06} fill="url(#vl-orbit-g)" style={{ animation: "vl-pulse 2s ease-in-out infinite" }} />
    </svg>
  );
}

/** Analytics charts, sprint data, reports */
export function VelocityBarsLoader({ size = 48 }: { size?: number }) {
  useEffect(() => { injectCSS(); }, []);
  const s = size;
  const bars = [
    { h: s*0.42, delay: "0s" },
    { h: s*0.65, delay: "0.12s" },
    { h: s*0.3,  delay: "0.24s" },
    { h: s*0.58, delay: "0.36s", cyan: true },
    { h: s*0.45, delay: "0.48s" },
  ];
  const bw = Math.max(4, s * 0.12);
  const gap = Math.max(2, s * 0.04);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap, width: s, height: s, paddingBottom: s*0.1 }} role="status" aria-label="Loading…">
      {bars.map((b, i) => (
        <div key={i} style={{ width: bw, height: b.h, background: b.cyan ? "linear-gradient(to top, var(--color-accent-cyan,#a5f3fc), var(--color-primary,#6366f1))" : "linear-gradient(to top, var(--color-primary,#6366f1), var(--color-primary-end,#8b5cf6))", borderRadius: 2, transformOrigin: "bottom", animation: `vl-bar 0.7s ${b.delay} ease-in-out infinite alternate` }} />
      ))}
    </div>
  );
}

/** Pipeline starting, SSE connecting, Slack syncing */
export function TerminalLoader({ size = 48, message = "syncing..." }: { size?: number; message?: string }) {
  useEffect(() => { injectCSS(); }, []);
  const fs = Math.max(6, size * 0.14);
  const dfs = Math.max(5, size * 0.12);
  const ds = Math.max(4, size * 0.1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: size*0.1, padding: size*0.1 }} role="status" aria-label="Loading…">
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: fs, letterSpacing: 2, color: "var(--color-primary,#6366f1)", opacity: 0.6, fontWeight: 600 }}>VELOCITY</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ color: "#22c55e", fontSize: dfs }}>▸</span>
        <div style={{ display: "flex", gap: 4, marginLeft: 2 }}>
          {[0, 0.2, 0.4].map((d, i) => (
            <div key={i} style={{ width: ds, height: ds, background: ["var(--color-primary,#6366f1)", "var(--color-primary-end,#8b5cf6)", "var(--color-accent-cyan,#a5f3fc)"][i], borderRadius: 1, animation: `vl-dot 1.2s ${d}s ease-in-out infinite` }} />
          ))}
        </div>
      </div>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: dfs, color: "var(--color-accent-cyan,#a5f3fc)", opacity: 0.5, letterSpacing: 1 }}>{message}</span>
    </div>
  );
}

/** Page-level transitions */
export function GlitchTransitionLoader({ size = 48 }: { size?: number }) {
  useEffect(() => { injectCSS(); }, []);
  const s = size;
  const cx = s / 2;
  const innerX = s * 0.18;
  const topY = s * 0.22;
  const midY = s * 0.68;
  const sw = Math.max(2, s * 0.075);
  const path = `M${innerX} ${topY} L${cx} ${midY} L${s-innerX} ${topY}`;
  return (
    <div style={{ position: "relative", width: s, height: s }} role="status" aria-label="Loading…">
      <svg style={{ position: "absolute" }} width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <defs>
          <linearGradient id="vl-glitch-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-primary,#6366f1)" />
            <stop offset="100%" stopColor="var(--color-primary-end,#8b5cf6)" />
          </linearGradient>
        </defs>
        <path d={path} stroke="url(#vl-glitch-g)" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      <svg style={{ position: "absolute", mixBlendMode: "screen", animation: "vl-glitch-r 2s ease-in-out infinite" }} width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <path d={path} stroke="#f43f5e" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.7} />
      </svg>
      <svg style={{ position: "absolute", mixBlendMode: "screen", animation: "vl-glitch-b 2s ease-in-out infinite" }} width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none">
        <path d={path} stroke="var(--color-accent-cyan,#a5f3fc)" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.6} />
      </svg>
    </div>
  );
}
