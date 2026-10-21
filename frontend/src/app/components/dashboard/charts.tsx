"use client";

// The dashboard's two charts, drawn in plain SVG so they inherit the app's
// theme. One measure per chart (no second axis), thin marks with 4px rounded
// ends, hairline solid gridlines, a hover/focus tooltip on every mark, and a
// table twin behind a toggle so no value is reachable only by hovering.
//
// Colours are chart roles, not palette hex in markup: the two categorical
// slots (requests in, requests closed) were validated for light and dark
// surfaces; magnitude uses one blue ramp.

import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";
import { fmt } from "@/app/lib/legalDashboard";
import { plural } from "@/app/lib/regulatoryRadar";

/** Chart roles. `.dark` on <html> switches them, like every other token in the app. */
export const VIZ_STYLE = `
.viz-root {
  --viz-series-1: #2a78d6;
  --viz-series-2: #eb6834;
  --viz-seq: #2a78d6;
  --viz-grid: #e1e0d9;
  --viz-axis: #c3c2b7;
  --viz-surface: #fcfcfb;
}
.dark .viz-root {
  --viz-series-1: #3987e5;
  --viz-series-2: #d95926;
  --viz-seq: #3987e5;
  --viz-grid: #2c2c2a;
  --viz-axis: #383835;
  --viz-surface: #1a1a19;
}
`;

/** The smallest round axis top at or above the value: 1, 2, 2.5 or 5 × 10^k. */
export function niceMax(value: number): number {
    if (value <= 4) return 4;
    const pow = 10 ** Math.floor(Math.log10(value));
    const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= value)!;
    return step * pow;
}

/** A path for a bar with a 4px rounded data end and a square base. */
function columnPath(x: number, y: number, w: number, h: number): string {
    if (h <= 0) return "";
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function barPath(x: number, y: number, w: number, h: number): string {
    if (w <= 0) return "";
    const r = Math.min(4, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export function ChartCard({
    title,
    subtitle,
    legend,
    table,
    children,
    className,
}: {
    title: string;
    subtitle?: ReactNode;
    legend?: ReactNode;
    table: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    const [asTable, setAsTable] = useState(false);
    return (
        <figure className={cn("viz-root min-w-0 rounded-xl border border-gray-200 bg-app-surface p-4", className)}>
            <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">{title}</span>
                    {subtitle ? <span className="block text-xs text-gray-500">{subtitle}</span> : null}
                </span>
                <button
                    type="button"
                    onClick={() => setAsTable((v) => !v)}
                    aria-pressed={asTable}
                    className="rounded-full px-2 py-0.5 text-[11px] text-gray-500 hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    {asTable ? "Ver gráfico" : "Ver tabela"}
                </button>
            </figcaption>
            {asTable ? (
                table
            ) : (
                <>
                    {legend}
                    {children}
                </>
            )}
        </figure>
    );
}

function LegendKey({ color, label }: { color: string; label: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
            {label}
        </span>
    );
}

export type WeeklyPoint = { week: string; opened: number; closed: number };

function shortWeek(iso: string): string {
    const [, m, d] = iso.split("-");
    return `${d}/${m}`;
}

/**
 * Requests in vs. requests closed, per week: two thin columns side by side
 * per week, one axis. Each column is a hover/focus target with the week's
 * full readout.
 */
export function WeeklyColumns({ data }: { data: WeeklyPoint[] }) {
    const id = useId();
    const [hover, setHover] = useState<number | null>(null);
    const W = 640;
    const H = 180;
    const pad = { top: 8, right: 8, bottom: 22, left: 28 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const top = niceMax(Math.max(1, ...data.map((d) => Math.max(d.opened, d.closed))));
    const band = data.length ? plotW / data.length : plotW;
    const barW = Math.max(2, Math.min(12, (band - 6) / 2));
    const y = (v: number) => pad.top + plotH - (v / top) * plotH;
    const ticks = [0, top / 2, top];
    const labelEvery = Math.max(1, Math.ceil(data.length / 8));

    const table = (
        <table className="w-full text-xs">
            <thead>
                <tr className="text-left text-gray-500">
                    <th className="py-1 font-normal">Semana de</th>
                    <th className="py-1 text-right font-normal">Entradas</th>
                    <th className="py-1 text-right font-normal">Concluídos</th>
                </tr>
            </thead>
            <tbody className="tabular-nums text-gray-800">
                {data.map((d) => (
                    <tr key={d.week} className="border-t border-gray-100">
                        <td className="py-1">{shortWeek(d.week)}</td>
                        <td className="py-1 text-right">{d.opened}</td>
                        <td className="py-1 text-right">{d.closed}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );

    const active = hover !== null ? data[hover] : null;

    return (
        <ChartCard
            title="Pedidos por semana"
            subtitle="Entradas na esteira e concluídos"
            table={table}
            legend={
                <div className="mb-2 flex gap-4">
                    <LegendKey color="var(--viz-series-1)" label="Entradas" />
                    <LegendKey color="var(--viz-series-2)" label="Concluídos" />
                </div>
            }
        >
            <div className="relative">
                <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={`${id}-t`}>
                    <title id={`${id}-t`}>Entradas e concluídos por semana</title>
                    {ticks.map((t) => (
                        <g key={t}>
                            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} />
                            <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-gray-400 text-[10px] tabular-nums">
                                {fmt(t)}
                            </text>
                        </g>
                    ))}
                    {data.map((d, i) => {
                        const cx = pad.left + band * i + band / 2;
                        const gap = 2;
                        const x1 = cx - gap / 2 - barW;
                        const x2 = cx + gap / 2;
                        return (
                            <g key={d.week}>
                                <path d={columnPath(x1, y(d.opened), barW, y(0) - y(d.opened))} fill="var(--viz-series-1)" opacity={hover === null || hover === i ? 1 : 0.45} />
                                <path d={columnPath(x2, y(d.closed), barW, y(0) - y(d.closed))} fill="var(--viz-series-2)" opacity={hover === null || hover === i ? 1 : 0.45} />
                                {i % labelEvery === 0 ? (
                                    <text x={cx} y={H - 6} textAnchor="middle" className="fill-gray-400 text-[10px] tabular-nums">
                                        {shortWeek(d.week)}
                                    </text>
                                ) : null}
                                {hover === i ? (
                                    // Focus/hover band: the ring a keyboard user sees.
                                    <rect
                                        x={pad.left + band * i + 1}
                                        y={pad.top}
                                        width={Math.max(0, band - 2)}
                                        height={plotH}
                                        fill="none"
                                        stroke="var(--viz-series-1)"
                                        strokeOpacity={0.5}
                                        strokeWidth={1.5}
                                        rx={4}
                                    />
                                ) : null}
                                {/* The hit target is the whole week band, not the 12px column. */}
                                <rect
                                    x={pad.left + band * i}
                                    y={pad.top}
                                    width={band}
                                    height={plotH}
                                    fill="transparent"
                                    tabIndex={0}
                                    aria-label={`Semana de ${shortWeek(d.week)}: ${plural(d.opened, "entrada", "entradas")}, ${plural(d.closed, "concluído", "concluídos")}`}
                                    onPointerEnter={() => setHover(i)}
                                    onPointerLeave={() => setHover(null)}
                                    onFocus={() => setHover(i)}
                                    onBlur={() => setHover(null)}
                                    className="cursor-default focus-visible:outline-none"
                                />
                            </g>
                        );
                    })}
                </svg>
                {active && hover !== null ? (
                    <div
                        role="status"
                        className="pointer-events-none absolute top-0 rounded-lg border border-gray-200 bg-app-floating px-2.5 py-1.5 text-xs shadow-sm"
                        style={{ left: `${Math.min(80, ((pad.left + band * hover + band / 2) / W) * 100)}%` }}
                    >
                        <p className="mb-1 text-[11px] text-gray-500">Semana de {shortWeek(active.week)}</p>
                        <p className="flex items-center gap-2">
                            <span aria-hidden="true" className="h-0.5 w-3 rounded" style={{ background: "var(--viz-series-1)" }} />
                            <strong className="tabular-nums text-gray-900">{active.opened}</strong>
                            <span className="text-gray-500">entradas</span>
                        </p>
                        <p className="flex items-center gap-2">
                            <span aria-hidden="true" className="h-0.5 w-3 rounded" style={{ background: "var(--viz-series-2)" }} />
                            <strong className="tabular-nums text-gray-900">{active.closed}</strong>
                            <span className="text-gray-500">concluídos</span>
                        </p>
                    </div>
                ) : null}
            </div>
        </ChartCard>
    );
}

export type BarRow = { label: string; value: number | null; note?: string };

/**
 * One magnitude per row (days per stage, requests per area): one hue, thin
 * horizontal bars, the value at the tip. A row without a value says so
 * instead of drawing a zero.
 */
export function HorizontalBars({
    title,
    subtitle,
    rows,
    unit,
    empty,
}: {
    title: string;
    subtitle?: ReactNode;
    rows: BarRow[];
    unit: string;
    empty?: string;
}) {
    const max = useMemo(() => Math.max(0, ...rows.map((r) => r.value ?? 0)), [rows]);
    const table = (
        <table className="w-full text-xs">
            <tbody className="tabular-nums text-gray-800">
                {rows.map((r) => (
                    <tr key={r.label} className="border-t border-gray-100 first:border-t-0">
                        <td className="py-1">{r.label}</td>
                        <td className="py-1 text-right">{r.value === null ? "—" : `${fmt(r.value)} ${unit}`}</td>
                        <td className="py-1 pl-3 text-right text-gray-500">{r.note ?? ""}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
    const W = 100;
    return (
        <ChartCard title={title} subtitle={subtitle} table={table}>
            {max === 0 && empty ? (
                <p className="py-6 text-xs text-gray-400">{empty}</p>
            ) : (
                <ul className="space-y-2">
                    {rows.map((r) => {
                        const share = r.value && max ? r.value / max : 0;
                        return (
                            <li key={r.label} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 text-xs">
                                <span className="truncate text-gray-600">{r.label}</span>
                                <span
                                    className="flex items-center gap-2"
                                    title={r.value === null ? `${r.label}: sem dado` : `${r.label}: ${fmt(r.value)} ${unit}${r.note ? ` · ${r.note}` : ""}`}
                                >
                                    <svg viewBox={`0 0 ${W} 12`} preserveAspectRatio="none" className="h-3 flex-1" aria-hidden="true">
                                        <path d={barPath(0, 0, share * (W - 2), 12)} fill="var(--viz-seq)" />
                                    </svg>
                                    <span className="w-20 shrink-0 tabular-nums text-gray-800">
                                        {r.value === null ? <span className="text-gray-300">—</span> : `${fmt(r.value)} ${unit}`}
                                    </span>
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </ChartCard>
    );
}
