"use client";

import {
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface ParetoChartPoint {
  id: string;
  label: string;
  mode: "live" | "replay";
  tokensPerTrial: number;
  passRate: number;
  n: number;
  onFrontier: boolean;
}

interface Datum {
  id: string;
  label: string;
  mode: "live" | "replay";
  x: number;
  y: number;
  n: number;
}

function toDatum(point: ParetoChartPoint): Datum {
  return {
    id: point.id,
    label: point.label,
    mode: point.mode,
    x: Math.round(point.tokensPerTrial),
    y: Math.round(point.passRate * 1000) / 10,
    n: point.n,
  };
}

const tokens = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });

function PointTooltip({ active, payload }: { active?: boolean; payload?: { payload?: Datum }[] }) {
  const datum = payload?.[0]?.payload;
  if (active !== true || datum === undefined) return null;
  return (
    <div className="max-w-72 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <p className="font-mono text-text">{datum.label}</p>
      <p className="mt-1 text-text-muted tabular">
        Pass rate {datum.y}% (n={datum.n}) · {tokens.format(datum.x)} tokens per trial
      </p>
      <p className="mt-1 font-mono text-2xs text-text-subtle">
        {datum.mode === "replay" ? "Replay" : "Live"} · {datum.id}
      </p>
    </div>
  );
}

export function ParetoChart({ points }: { points: readonly ParetoChartPoint[] }) {
  const frontier = points
    .filter((point) => point.onFrontier)
    .map(toDatum)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const dominated = points.filter((point) => !point.onFrontier).map(toDatum);
  return (
    <div className="h-72 w-full" role="img" aria-label="Pass rate against tokens per trial">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            type="number"
            dataKey="x"
            name="Tokens per trial"
            tickFormatter={(value: number) => tokens.format(value)}
            stroke="var(--border-strong)"
            tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
            label={{
              value: "Tokens per trial (lower is cheaper)",
              position: "insideBottom",
              offset: -16,
              fill: "var(--text-subtle)",
              fontSize: 11,
            }}
            domain={[0, "auto"]}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Pass rate"
            unit="%"
            domain={[0, 100]}
            stroke="var(--border-strong)"
            tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
            width={44}
          />
          <Tooltip content={<PointTooltip />} cursor={{ stroke: "var(--border-strong)" }} />
          <Line
            data={frontier}
            dataKey="y"
            type="stepAfter"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
          <Scatter
            data={frontier}
            fill="var(--accent)"
            stroke="var(--surface)"
            strokeWidth={2}
            isAnimationActive={false}
          />
          <Scatter
            data={dominated}
            fill="var(--surface)"
            stroke="var(--text-subtle)"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
