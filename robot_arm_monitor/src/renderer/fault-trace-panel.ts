type FTCapture = import("../shared/types").FaultTraceCapture;
type FTSample = import("../shared/types").FaultTraceSample;

type FTPlotData = Array<Array<number | null>>;

interface FTPlotInstance {
  setData(data: FTPlotData): void;
  setSize(size: { width: number; height: number }): void;
  destroy(): void;
}

interface FTPlotConstructor {
  new(options: Record<string, unknown>, data: FTPlotData, container: HTMLElement): FTPlotInstance;
}

interface FTContainers {
  position: HTMLElement;
  diff: HTMLElement;
  velocity: HTMLElement;
  current: HTMLElement;
}

namespace FaultTracePanel {
  export class Store {
    readonly captures: FTCapture[] = [];

    constructor(private readonly maxCaptures = 20) {}

    add(capture: FTCapture): void {
      this.captures.unshift(capture);
      if (this.captures.length > this.maxCaptures) this.captures.length = this.maxCaptures;
    }

    get(index: number): FTCapture | undefined {
      return this.captures[index];
    }
  }

  export class Viewer {
    private readonly charts: FTPlotInstance[];
    private readonly resizeObserver: ResizeObserver;

    constructor(
      private readonly Plot: FTPlotConstructor,
      private readonly containers: FTContainers
    ) {
      this.charts = this.createCharts();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      Object.values(containers).forEach(container => this.resizeObserver.observe(container));
    }

    show(capture: FTCapture): void {
      const n = capture.samples.length;
      const times = timeAxis(capture.samples, capture.intervalMs);
      const faultAtSec = firstFaultTimeSec(capture.samples, times);
      this.charts[0].setData([times, col(capture.samples, s => s.stepPos), col(capture.samples, s => s.encSteps)]);
      this.charts[1].setData([times, col(capture.samples, s => s.diff)]);
      this.charts[2].setData([times, col(capture.samples, s => s.vel)]);
      this.charts[3].setData([times, col(capture.samples, s => s.currentMa)]);
      this.charts.forEach(chart => setFaultMarker(chart, faultAtSec));
      void n;
    }

    resize(): void {
      const list: Array<[FTPlotInstance, HTMLElement]> = [
        [this.charts[0], this.containers.position], [this.charts[1], this.containers.diff],
        [this.charts[2], this.containers.velocity], [this.charts[3], this.containers.current]
      ];
      list.forEach(([chart, container]) => chart.setSize({ width: chartWidth(container), height: 200 }));
    }

    private createCharts(): FTPlotInstance[] {
      const teal = "#52d1db";
      const gold = "#f0c674";
      const violet = "#d09cf1";
      return [
        new this.Plot(
          ftOptions(this.containers.position, [ftLine("ステップ位置", teal), ftLine("エンコーダ換算位置", gold, [7, 4])]),
          [[], [], []], this.containers.position
        ),
        new this.Plot(ftOptions(this.containers.diff, [ftLine("偏差", violet)]), [[], []], this.containers.diff),
        new this.Plot(ftOptions(this.containers.velocity, [ftLine("速度", teal)]), [[], []], this.containers.velocity),
        new this.Plot(ftOptions(this.containers.current, [ftLine("電流", gold)]), [[], []], this.containers.current)
      ];
    }
  }
}

function timeAxis(samples: FTSample[], intervalMs: number): number[] {
  const n = samples.length;
  return samples.map((_, i) => ((i - (n - 1)) * intervalMs) / 1000);
}

function col(samples: FTSample[], pick: (s: FTSample) => number): Array<number | null> {
  return samples.map(s => (Number.isFinite(pick(s)) ? pick(s) : null));
}

/** First sample index where state === "FAULT", converted to the same relative-second axis as timeAxis. */
function firstFaultTimeSec(samples: FTSample[], times: number[]): number | undefined {
  const index = samples.findIndex(s => s.state === "FAULT");
  return index >= 0 ? times[index] : undefined;
}

function setFaultMarker(chart: FTPlotInstance & { faultAtSec?: number }, faultAtSec: number | undefined): void {
  chart.faultAtSec = faultAtSec;
}

function ftLine(label: string, stroke: string, dash: number[] = []): Record<string, unknown> {
  return { label, stroke, width: 1.5, dash, points: { show: false }, spanGaps: true };
}

function ftOptions(container: HTMLElement, series: Record<string, unknown>[]): Record<string, unknown> {
  return {
    width: ftChartWidth(container), height: 200,
    cursor: { drag: { x: true, y: false }, focus: { prox: 24 } },
    legend: { show: true },
    scales: { x: { time: false } },
    axes: [{ ...ftAxisStyle(), label: "経過秒" }, ftAxisStyle()],
    series: [{ label: "t[s]" }, ...series],
    plugins: [faultMarkerPlugin()]
  };
}

function ftAxisStyle(): Record<string, unknown> {
  return { stroke: "#8ea0b2", grid: { stroke: "#273646", width: 1 }, ticks: { stroke: "#273646" }, size: 62 };
}

function ftChartWidth(container: HTMLElement): number {
  return Math.max(320, Math.floor(container.clientWidth || 600));
}

/** Draws a vertical red dashed line at plot.faultAtSec (set via setFaultMarker before each render). */
function faultMarkerPlugin(): Record<string, unknown> {
  return { hooks: { draw: [(plot: any) => {
    const at: number | undefined = plot.faultAtSec;
    if (at === undefined) return;
    const { ctx, bbox } = plot;
    const x = Math.round(plot.valToPos(at, "x", true));
    if (x < bbox.left || x > bbox.left + bbox.width) return;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "#ff6262";
    ctx.beginPath();
    ctx.moveTo(x, bbox.top);
    ctx.lineTo(x, bbox.top + bbox.height);
    ctx.stroke();
    ctx.restore();
  }] } };
}

if (typeof module !== "undefined") module.exports = FaultTracePanel;
