"use client";

import { useEffect, useRef } from "react";
import { formatBitsPerSecond } from "@/lib/format/units";
import type { Point, StreamStatus } from "@/lib/realtime/types";

/**
 * Realtime sliding traffic chart.
 *
 * Rendered on <canvas> rather than SVG: at 1 Hz with up to 900 points the DOM churn
 * of an SVG chart is a performance cliff, while a canvas draw is one paint. The draw
 * loop reads from refs, so React never re-renders per frame.
 *
 * What the chart may claim is decided by `status`, not by the line:
 *   live   - draw the series
 *   idle   - draw the flat axis with "No realtime traffic data"
 *   stale  - draw empty with "Gateway unavailable" (never a zero line)
 *   mock   - draw with a DEV badge; the line is explicitly labelled mock data
 */

export type SeriesVisibility = { upload: boolean; download: boolean; total: boolean };

interface RealtimeChartProps {
  points: Point[];
  status: StreamStatus | null;
  visible: SeriesVisibility;
  height?: number;
  className?: string;
  onHover?: (point: Point | null, x: number) => void;
}

const CHART_COLORS = {
  grid: "rgba(39, 39, 42, 0.9)",
  axis: "#71717A",
  download: "#3B82F6",
  upload: "#22C55E",
  total: "#A1A1AA",
};

export const CHART_PADDING = { left: 56, right: 12, top: 12, bottom: 22 };

function seriesMax(points: Point[], visible: SeriesVisibility): number {
  let max = 1;
  for (const point of points) {
    if (visible.download) max = Math.max(max, point.downloadBps);
    if (visible.upload) max = Math.max(max, point.uploadBps);
    if (visible.total) max = Math.max(max, point.totalBps);
  }
  return max;
}

export function RealtimeChart({ points, status, visible, height = 240, className, onHover }: RealtimeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pointsRef = useRef<Point[]>(points);
  pointsRef.current = points;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let destroyed = false;

    function resize() {
      const wrap = wrapRef.current;
      if (!wrap || !canvas || !context) return;
      const rect = wrap.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    resize();
    const observer = new ResizeObserver(resize);
    if (wrapRef.current) observer.observe(wrapRef.current);

    function draw() {
      if (destroyed || !canvas || !context) return;
      const width = canvas.clientWidth;
      const pad = CHART_PADDING;
      const plotWidth = Math.max(1, width - pad.left - pad.right);
      const plotHeight = Math.max(1, height - pad.top - pad.bottom);

      const current = pointsRef.current;
      const vis = visibleRef.current;

      context.clearRect(0, 0, width, height);

      const max = seriesMax(current, vis) * 1.15;
      const xOf = (index: number) =>
        current.length <= 1 ? pad.left : pad.left + (index / (current.length - 1)) * plotWidth;
      const yOf = (value: number) => pad.top + plotHeight - (value / max) * plotHeight;

      context.font = "10px 'JetBrains Mono', monospace";
      context.fillStyle = CHART_COLORS.axis;
      context.strokeStyle = CHART_COLORS.grid;
      context.lineWidth = 1;
      for (let division = 0; division <= 4; division += 1) {
        const value = (max / 4) * division;
        const y = yOf(value);
        context.beginPath();
        context.moveTo(pad.left, y);
        context.lineTo(width - pad.right, y);
        context.stroke();
        context.fillText(formatBitsPerSecond(value * 8, 0), 4, y + 3);
      }

      if (current.length > 1) {
        const first = new Date(current[0]?.t ?? 0);
        const last = new Date(current[current.length - 1]?.t ?? 0);
        const label = (date: Date) =>
          `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
            date.getSeconds(),
          ).padStart(2, "0")}`;
        context.fillText(label(first), pad.left, height - 6);
        const lastLabel = label(last);
        context.fillText(lastLabel, width - pad.right - context.measureText(lastLabel).width, height - 6);
      }

      const trace = (pick: (point: Point) => number) => {
        context.beginPath();
        current.forEach((point, index) => {
          const x = xOf(index);
          const y = yOf(pick(point));
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      };

      context.lineWidth = 1.5;
      context.lineJoin = "round";
      if (vis.total) {
        context.strokeStyle = CHART_COLORS.total;
        trace((point) => point.totalBps);
      }
      if (vis.upload) {
        context.strokeStyle = CHART_COLORS.upload;
        trace((point) => point.uploadBps);
      }
      if (vis.download) {
        context.strokeStyle = CHART_COLORS.download;
        trace((point) => point.downloadBps);
      }

      if (!reduceMotion) frame = requestAnimationFrame(draw);
    }

    if (reduceMotion) draw();
    else frame = requestAnimationFrame(draw);

    return () => {
      destroyed = true;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [height]);

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    const wrap = wrapRef.current;
    if (!wrap || points.length === 0 || !hoverRef.current) return;
    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotWidth = Math.max(1, rect.width - CHART_PADDING.left - CHART_PADDING.right);
    const fraction = Math.min(1, Math.max(0, (x - CHART_PADDING.left) / plotWidth));
    const index = Math.round(fraction * (points.length - 1));
    hoverRef.current(points[index] ?? null, x);
  }

  const empty = points.length === 0 || status === "stale";

  return (
    <div
      ref={wrapRef}
      className={`relative ${className ?? ""}`}
      onMouseMove={onMove}
      onMouseLeave={() => hoverRef.current?.(null, 0)}
    >
      <canvas ref={canvasRef} aria-label="Realtime throughput chart" role="img" />
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center" aria-live="polite">
          <p className="micro-label">{status === "stale" ? "Gateway unavailable" : "No realtime traffic data"}</p>
        </div>
      )}
      {status === "mock" && points.length > 0 && (
        <span className="status status-warning absolute left-2 top-2">DEV - mock feed</span>
      )}
    </div>
  );
}
