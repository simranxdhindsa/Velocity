import { useEffect, useRef, useState } from "react";

type Variant = "icon" | "horizontal" | "sidebar";
type Size = "xs" | "sm" | "md" | "lg" | "xl";
type Theme = "dark" | "light" | "auto";
type Mark = "chevron" | "quantum" | "glitch";

interface VelocityLogoProps {
  variant?: Variant;
  size?: Size;
  theme?: Theme;
  mark?: Mark;
  showStatusDot?: boolean;
  animate?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const SIZE_MAP: Record<Size, number> = {
  xs: 16,
  sm: 24,
  md: 40,
  lg: 64,
  xl: 96,
};

function ChevronMark({ size, opacity = 1 }: { size: number; opacity?: number }) {
  const s = size;
  const cx = s / 2;
  const tipY = s * 0.83;
  const topY = s * 0.22;
  const outerX = s * 0.08;
  const innerX = s * 0.18;
  const stroke = Math.max(1.5, s * 0.07);
  const id = `vl-chevron-${s}`;

  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" style={{ opacity }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-primary, #6366f1)" />
          <stop offset="100%" stopColor="var(--color-primary-end, #8b5cf6)" />
        </linearGradient>
      </defs>
      <path
        d={`M${outerX} ${topY} L${cx} ${tipY} L${s - outerX} ${topY}`}
        stroke={`url(#${id})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity={0.22}
      />
      <path
        d={`M${innerX} ${topY} L${cx} ${s * 0.68} L${s - innerX} ${topY}`}
        stroke={`url(#${id})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx={cx} cy={tipY} r={Math.max(1.5, s * 0.045)} fill="var(--color-accent-cyan, #a5f3fc)" />
    </svg>
  );
}

function QuantumMark({ size, opacity = 1 }: { size: number; opacity?: number }) {
  const s = size;
  const cx = s / 2;
  const rx = s * 0.42;
  const ry = s * 0.14;
  const nucleusR = s * 0.14;
  const coreR = s * 0.065;
  const dotR = s * 0.03;
  const gid = `vl-quantum-${s}`;
  const rid = `vl-quantum-r-${s}`;

  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" style={{ opacity }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-primary, #6366f1)" />
          <stop offset="100%" stopColor="var(--color-primary-end, #8b5cf6)" />
        </linearGradient>
        <radialGradient id={rid} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-accent-cyan, #a5f3fc)" stopOpacity={0.4} />
          <stop offset="40%" stopColor="var(--color-primary, #6366f1)" stopOpacity={0.18} />
          <stop offset="100%" stopColor="transparent" stopOpacity={0} />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cx} r={s * 0.46} fill={`url(#${rid})`} />
      <ellipse cx={cx} cy={cx} rx={rx} ry={ry} stroke={`url(#${gid})`} strokeWidth={Math.max(0.6, s * 0.012)} fill="none" opacity={0.55} />
      <ellipse cx={cx} cy={cx} rx={rx} ry={ry} stroke={`url(#${gid})`} strokeWidth={Math.max(0.5, s * 0.01)} fill="none" opacity={0.35} transform={`rotate(60 ${cx} ${cx})`} />
      <ellipse cx={cx} cy={cx} rx={rx} ry={ry} stroke={`url(#${gid})`} strokeWidth={Math.max(0.5, s * 0.01)} fill="none" opacity={0.35} transform={`rotate(120 ${cx} ${cx})`} />
      <circle cx={cx} cy={cx} r={nucleusR} fill="var(--color-background, #020617)" stroke={`url(#${gid})`} strokeWidth={Math.max(1, s * 0.02)} />
      <circle cx={cx} cy={cx} r={coreR} fill={`url(#${gid})`} />
      <circle cx={cx} cy={cx} r={dotR} fill="var(--color-accent-cyan, #a5f3fc)" opacity={0.9} />
    </svg>
  );
}

export function VelocityLogo({
  variant = "icon",
  size = "md",
  theme = "auto",
  mark = "glitch",
  showStatusDot = true,
  animate = false,
  className = "",
  style,
}: VelocityLogoProps) {
  const px = SIZE_MAP[size];
  const [currentMark, setCurrentMark] = useState<"chevron" | "quantum">("chevron");
  const [glitching, setGlitching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mark !== "glitch") return;
    const cycle = () => {
      setGlitching(true);
      setTimeout(() => {
        setCurrentMark((prev) => (prev === "chevron" ? "quantum" : "chevron"));
        setTimeout(() => setGlitching(false), 400);
      }, 300);
    };
    timerRef.current = setInterval(cycle, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mark]);

  void animate;

  const resolvedMark = mark === "glitch" ? currentMark : mark;
  const isDark = theme === "dark" || theme === "auto";
  const MarkComponent = resolvedMark === "chevron" ? ChevronMark : QuantumMark;

  const glitchStyle: React.CSSProperties = glitching
    ? { filter: "drop-shadow(2px 0 0 rgba(244,63,94,0.6)) drop-shadow(-2px 0 0 rgba(165,243,252,0.5))", transform: `translateX(2px)`, transition: "none" }
    : { filter: `drop-shadow(0 0 ${px * 0.08}px var(--color-primary, #6366f1))`, transition: "filter 0.3s ease, transform 0.1s ease" };

  const statusDot = showStatusDot ? (
    <div style={{ width: Math.max(4, px * 0.12), height: Math.max(4, px * 0.12), borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e" }} />
  ) : null;

  if (variant === "icon") {
    return (
      <div className={className} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", position: "relative", ...glitchStyle, ...style }}>
        <MarkComponent size={px} />
        {showStatusDot && (
          <div style={{ position: "absolute", bottom: 0, right: 0, width: Math.max(4, px * 0.12), height: Math.max(4, px * 0.12), borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e" }} />
        )}
      </div>
    );
  }

  if (variant === "sidebar") {
    return (
      <div className={className} style={{ display: "inline-flex", alignItems: "center", gap: "10px", width: "100%", ...style }}>
        <div style={glitchStyle}><MarkComponent size={SIZE_MAP["sm"]} /></div>
        <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: "14px", fontWeight: 800, letterSpacing: "3px", color: "var(--color-text-primary, #f1f5f9)" }}>VELOCITY</span>
        {statusDot && <div style={{ marginLeft: "auto" }}>{statusDot}</div>}
      </div>
    );
  }

  // horizontal
  return (
    <div className={className} style={{ display: "inline-flex", alignItems: "center", gap: px * 0.35, ...style }}>
      <div style={glitchStyle}><MarkComponent size={px} /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: px * 0.5, fontWeight: 800, letterSpacing: px * 0.15, color: isDark ? "var(--color-text-primary, #f1f5f9)" : "var(--color-text-primary, #0f172a)", lineHeight: 1 }}>VELOCITY</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: px * 0.17, fontWeight: 500, letterSpacing: px * 0.08, color: "var(--color-primary, #6366f1)" }}>PROJECT MANAGEMENT</span>
      </div>
      {statusDot && <div style={{ marginLeft: "auto" }}>{statusDot}</div>}
    </div>
  );
}

export default VelocityLogo;
