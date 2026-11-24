import type { ReactNode } from "react";

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg
      viewBox="0 0 160 48"
      fill="none"
      role="img"
      aria-label={label}
      className="h-12 w-40 text-text-subtle"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function QuarantineDiagram() {
  return (
    <Frame label="Untrusted page passes through a tool-less reader and leaves as typed fields">
      <rect
        x="1.5"
        y="10.5"
        width="34"
        height="27"
        rx="3"
        stroke="currentColor"
        strokeDasharray="3 3"
      />
      <path d="M8 18h21M8 24h17M8 30h19" stroke="currentColor" opacity="0.6" />
      <path d="M40 24h14M50 20l4 4-4 4" stroke="currentColor" />
      <rect x="58.5" y="6.5" width="40" height="35" rx="3" stroke="var(--text)" />
      <path d="M68 6.5v35M89 6.5v35" stroke="currentColor" opacity="0.5" />
      <path d="M103 24h14M113 20l4 4-4 4" stroke="currentColor" />
      <path d="M124 14h8M136 14h22M124 24h8M136 24h16M124 34h8M136 34h19" stroke="var(--text)" />
    </Frame>
  );
}

export function PolicyDiagram() {
  return (
    <Frame label="Every tool call meets a policy gate that allows or denies it">
      <path d="M2 24h52" stroke="currentColor" />
      <circle cx="6" cy="24" r="2.5" fill="var(--bg)" stroke="var(--text)" />
      <path d="M58 6v36" stroke="var(--text)" strokeWidth="2" />
      <path d="M62 24c14 0 18-12 32-12h40" stroke="var(--success)" />
      <path d="M140 8.5l4 3.5-4 3.5" stroke="var(--success)" />
      <path d="M62 24c14 0 18 12 32 12h22" stroke="var(--danger)" />
      <path d="M120 32l8 8M128 32l-8 8" stroke="var(--danger)" />
    </Frame>
  );
}

export function EventLogDiagram() {
  const ticks = [6, 26, 46, 66, 86, 106, 126];
  return (
    <Frame label="An append-only sequence of events that can be replayed from any step">
      <path d="M2 34h154" stroke="currentColor" />
      {ticks.map((x) => (
        <path key={x} d={`M${x} 28v12`} stroke="var(--text)" />
      ))}
      <path d="M146 28v12" stroke="var(--accent)" strokeWidth="2" />
      <path d="M126 22c0-12-80-12-80 0" stroke="currentColor" strokeDasharray="3 3" />
      <path d="M42.5 18l3.5 4 3.5-4" stroke="currentColor" />
    </Frame>
  );
}

export function EvalsDiagram() {
  const points = [
    { x: 18, y: 26, spread: 9 },
    { x: 54, y: 20, spread: 7 },
    { x: 90, y: 17, spread: 5 },
    { x: 126, y: 14, spread: 4 },
  ];
  return (
    <Frame label="Scores plotted with 95 percent confidence intervals against a regression threshold">
      <path d="M2 32h156" stroke="currentColor" strokeDasharray="2 3" />
      {points.map((point) => (
        <g key={point.x}>
          <path
            d={`M${point.x} ${point.y - point.spread}v${point.spread * 2}M${point.x - 3} ${point.y - point.spread}h6M${point.x - 3} ${point.y + point.spread}h6`}
            stroke="currentColor"
          />
          <circle cx={point.x} cy={point.y} r="2.5" fill="var(--bg)" stroke="var(--text)" />
        </g>
      ))}
    </Frame>
  );
}
