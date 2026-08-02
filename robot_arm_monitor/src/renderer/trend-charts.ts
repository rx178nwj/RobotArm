type TrendAxisSnapshot = import("../shared/types").AxisSnapshot;
type TrendRobotArmSnapshot = import("../shared/types").RobotArmSnapshot;

type TrendMetric = "velocity" | "deviation" | "currentMa" | "voltageV" | "gearDiff";
type AxisColumnKey = TrendMetric | "stepPos" | "encoderPos" | "gearRelayed" | "gearDirect" | "gearExceeded";
type PlotData = Array<Array<number | null>>;

interface PlotInstance {
  data: PlotData;
  setData(data: PlotData): void;
  setSize(size: { width: number; height: number }): void;
  destroy(): void;
}

interface PlotConstructor {
  new(options: Record<string, unknown>, data: PlotData, container: HTMLElement): PlotInstance;
}

interface TrendContainers {
  velocity: HTMLElement;
  position: HTMLElement;
  deviation: HTMLElement;
  power: HTMLElement;
  gear: HTMLElement;
  comparison: HTMLElement;
}

interface AxisColumns {
  velocity: Array<number | null>;
  stepPos: Array<number | null>;
  encoderPos: Array<number | null>;
  deviation: Array<number | null>;
  currentMa: Array<number | null>;
  voltageV: Array<number | null>;
  gearRelayed: Array<number | null>;
  gearDirect: Array<number | null>;
  gearDiff: Array<number | null>;
  gearExceeded: Array<number | null>;
}

namespace TrendCharts {
  export class RobotArmTrendBuffer {
    readonly times: number[] = [];
    readonly columns = new Map<number, AxisColumns>();
    readonly labels = new Map<number, string>();
    private lastTimestamp = 0;

    constructor(readonly maxDurationSeconds = 300) {}

    push(snapshot: TrendRobotArmSnapshot): boolean {
      const timestamp = Number(snapshot.timestamp) / 1000;
      if (!Number.isFinite(timestamp) || timestamp <= this.lastTimestamp) return false;
      this.lastTimestamp = timestamp;
      this.times.push(timestamp);
      for (const columns of this.columns.values()) appendNull(columns);

      for (const axis of snapshot.axes) {
        if (axis.axisId === null) continue;
        const columns = this.ensureAxis(axis.axisId);
        this.labels.set(axis.axisId, axis.axisLabel || `Axis ${axis.axisId}`);
        setLast(columns, axis);
      }
      this.trim(timestamp - this.maxDurationSeconds - 2);
      return true;
    }

    axisWindow(seconds: number, axisId: number, keys: AxisColumnKey[]): PlotData {
      const start = this.windowStart(seconds);
      const columns = this.columns.get(axisId);
      return [
        this.times.slice(start),
        ...keys.map(key => columns ? columns[key].slice(start) : [])
      ];
    }

    comparisonWindow(seconds: number, metric: TrendMetric, axisIds: number[]): PlotData {
      const start = this.windowStart(seconds);
      return [
        this.times.slice(start),
        ...axisIds.map(axisId => this.columns.get(axisId)?.[metric].slice(start) ?? [])
      ];
    }

    axisIds(): number[] {
      return [...this.columns.keys()].sort((a, b) => a - b).slice(0, 12);
    }

    clear(): void {
      this.times.length = 0;
      this.columns.clear();
      this.labels.clear();
      this.lastTimestamp = 0;
    }

    private ensureAxis(axisId: number): AxisColumns {
      let columns = this.columns.get(axisId);
      if (columns) return columns;
      columns = emptyColumns(this.times.length);
      // The current timestamp already exists; setLast will replace this final null.
      this.columns.set(axisId, columns);
      return columns;
    }

    private windowStart(seconds: number): number {
      if (!this.times.length) return 0;
      const cutoff = this.times[this.times.length - 1] - seconds;
      let start = 0;
      while (start < this.times.length && this.times[start] < cutoff) start++;
      return start;
    }

    private trim(cutoff: number): void {
      let count = 0;
      while (count < this.times.length && this.times[count] < cutoff) count++;
      if (!count) return;
      this.times.splice(0, count);
      for (const columns of this.columns.values()) {
        for (const values of Object.values(columns)) values.splice(0, count);
      }
    }
  }

  export class RobotArmTrendDashboard {
    readonly buffer = new RobotArmTrendBuffer();
    private readonly detailCharts: PlotInstance[];
    private comparisonChart?: PlotInstance;
    private windowSeconds = 60;
    private axisId = 1;
    private comparisonMetric: TrendMetric = "velocity";
    private paused = false;
    private detailActive = false;
    private comparisonActive = false;
    private frameRequested = false;
    private readonly resizeObserver: ResizeObserver;

    constructor(
      private readonly Plot: PlotConstructor,
      private readonly containers: TrendContainers,
      private readonly mismatchThresholdDeg = 1
    ) {
      this.detailCharts = this.createDetailCharts();
      this.recreateComparisonChart();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      Object.values(containers).forEach(container => this.resizeObserver.observe(container));
    }

    add(snapshot: TrendRobotArmSnapshot): void {
      const before = this.buffer.axisIds().join(",");
      if (!this.buffer.push(snapshot)) return;
      if (before !== this.buffer.axisIds().join(",")) this.recreateComparisonChart();
      if (this.paused) return;
      if (this.detailActive || this.comparisonActive) this.scheduleRender();
    }

    setAxis(axisId: number): void {
      this.axisId = axisId;
      if (!this.paused && this.detailActive) this.renderDetail();
    }

    setComparisonMetric(metric: TrendMetric): void {
      this.comparisonMetric = metric;
      this.recreateComparisonChart();
      if (!this.paused && this.comparisonActive) this.renderComparison();
    }

    setWindow(seconds: number): void {
      this.windowSeconds = [10, 30, 60, 300].includes(seconds) ? seconds : 60;
      if (!this.paused) this.render();
    }

    setPaused(paused: boolean): void {
      this.paused = paused;
      if (!paused) this.render();
    }

    setActiveViews(detail: boolean, comparison: boolean): void {
      this.detailActive = detail;
      this.comparisonActive = comparison;
      requestAnimationFrame(() => {
        this.resize();
        if (!this.paused) this.render();
      });
    }

    clear(): void {
      this.buffer.clear();
      this.recreateComparisonChart();
      this.render();
    }

    render(): void {
      if (this.detailActive) this.renderDetail();
      if (this.comparisonActive) this.renderComparison();
    }

    private renderDetail(): void {
      const id = this.axisId;
      this.detailCharts[0].setData(this.buffer.axisWindow(this.windowSeconds, id, ["velocity"]));
      this.detailCharts[1].setData(this.buffer.axisWindow(this.windowSeconds, id, ["stepPos", "encoderPos"]));
      this.detailCharts[2].setData(this.buffer.axisWindow(this.windowSeconds, id, ["deviation"]));
      this.detailCharts[3].setData(this.buffer.axisWindow(this.windowSeconds, id, ["currentMa", "voltageV"]));
      this.detailCharts[4].setData(this.buffer.axisWindow(
        this.windowSeconds, id, ["gearRelayed", "gearDirect", "gearDiff", "gearExceeded"]
      ));
    }

    private renderComparison(): void {
      if (!this.comparisonChart) return;
      const ids = this.buffer.axisIds();
      this.comparisonChart.setData(this.buffer.comparisonWindow(this.windowSeconds, this.comparisonMetric, ids));
    }

    private scheduleRender(): void {
      if (this.frameRequested) return;
      this.frameRequested = true;
      requestAnimationFrame(() => {
        this.frameRequested = false;
        this.render();
      });
    }

    private createDetailCharts(): PlotInstance[] {
      const teal = "#52d1db";
      const gold = "#f0c674";
      const violet = "#d09cf1";
      const red = "#ff6262";
      return [
        new this.Plot(options(this.containers.velocity, [line("速度 [steps/s]", teal)]), [[], []], this.containers.velocity),
        new this.Plot(options(this.containers.position, [line("ステップ位置", teal), line("エンコーダ位置", gold, [7, 4])]), [[], [], []], this.containers.position),
        new this.Plot(options(this.containers.deviation, [line("偏差", violet)]), [[], []], this.containers.deviation),
        new this.Plot(options(this.containers.power, [
          { ...line("電流 [mA]", teal), scale: "current" },
          { ...line("電圧 [V]", gold), scale: "voltage" }
        ], {
          scales: { x: { time: true }, current: { auto: true }, voltage: { auto: true } },
          axes: [axisStyle(), { ...axisStyle(), scale: "current", label: "mA" }, { ...axisStyle(), scale: "voltage", side: 1, label: "V", grid: { show: false } }]
        }), [[], [], []], this.containers.power),
        new this.Plot(options(this.containers.gear, [
          line("中継角度", teal), line("bridge直接角度", gold), line("差分", violet),
          { ...line("閾値超過", red), width: 0, points: { show: true, size: 8, fill: red } }
        ], { plugins: [thresholdPlugin(this.mismatchThresholdDeg)] }), [[], [], [], [], []], this.containers.gear)
      ];
    }

    private recreateComparisonChart(): void {
      this.comparisonChart?.destroy();
      this.containers.comparison.innerHTML = "";
      const ids = this.buffer.axisIds();
      this.comparisonChart = new this.Plot(options(
        this.containers.comparison,
        ids.map((axisId, index) => line(
          this.buffer.labels.get(axisId) ?? `Axis ${axisId}`,
          palette[index % palette.length]
        ))
      ), Array.from({ length: ids.length + 1 }, () => []), this.containers.comparison);
    }

    private resize(): void {
      const detailContainers = [
        this.containers.velocity, this.containers.position, this.containers.deviation,
        this.containers.power, this.containers.gear
      ];
      this.detailCharts.forEach((chart, index) => chart.setSize({ width: chartWidth(detailContainers[index]), height: 220 }));
      this.comparisonChart?.setSize({ width: chartWidth(this.containers.comparison), height: 300 });
    }
  }

  export const METRICS: ReadonlyArray<{ value: TrendMetric; label: string }> = [
    { value: "velocity", label: "速度" },
    { value: "deviation", label: "偏差" },
    { value: "currentMa", label: "電流" },
    { value: "voltageV", label: "電圧" },
    { value: "gearDiff", label: "ギア角度差分" }
  ];
}

function emptyColumns(length: number): AxisColumns {
  const empty = (): Array<number | null> => Array.from({ length }, () => null);
  return {
    velocity: empty(), stepPos: empty(), encoderPos: empty(), deviation: empty(), currentMa: empty(),
    voltageV: empty(), gearRelayed: empty(), gearDirect: empty(), gearDiff: empty(), gearExceeded: empty()
  };
}

function appendNull(columns: AxisColumns): void {
  for (const values of Object.values(columns)) values.push(null);
}

function setLast(columns: AxisColumns, axis: TrendAxisSnapshot): void {
  const set = (key: AxisColumnKey, value: unknown): void => {
    columns[key][columns[key].length - 1] = Number.isFinite(value) ? Number(value) : null;
  };
  set("velocity", axis.motor?.velocity);
  set("stepPos", axis.motor?.stepPos);
  set("encoderPos", axis.motor?.encoderPos);
  set("deviation", axis.motor?.deviation);
  set("currentMa", axis.motor?.currentMa);
  set("voltageV", axis.motor?.voltageV);
  set("gearRelayed", axis.gearRelayed?.angleDeg);
  set("gearDirect", axis.gearDirect?.angleDeg);
  const diff = axis.gearRelayed?.angleDeg != null && axis.gearDirect?.angleDeg != null
    ? angularDifference(axis.gearRelayed.angleDeg, axis.gearDirect.angleDeg)
    : null;
  set("gearDiff", diff);
  set("gearExceeded", axis.gearMismatch?.exceeded ? diff : null);
}

function angularDifference(relayed: number, direct: number): number {
  return ((relayed - direct + 540) % 360) - 180;
}

function line(label: string, stroke: string, dash: number[] = []): Record<string, unknown> {
  return { label, stroke, width: 1.5, dash, points: { show: false }, spanGaps: true };
}

function options(container: HTMLElement, series: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    width: chartWidth(container), height: 220,
    cursor: { drag: { x: true, y: false }, focus: { prox: 24 } },
    legend: { show: true },
    scales: { x: { time: true } },
    axes: [axisStyle(), axisStyle()],
    series: [{ label: "時刻" }, ...series],
    ...extra
  };
}

function axisStyle(): Record<string, unknown> {
  return { stroke: "#8ea0b2", grid: { stroke: "#273646", width: 1 }, ticks: { stroke: "#273646" }, size: 62 };
}

function chartWidth(container: HTMLElement): number {
  return Math.max(320, Math.floor(container.clientWidth || 600));
}

function thresholdPlugin(threshold: number): Record<string, unknown> {
  return { hooks: { draw: [(plot: any) => {
    const { ctx, bbox } = plot;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "#ff6262";
    ctx.fillStyle = "#ff6262";
    ctx.font = "11px Segoe UI";
    for (const value of [threshold, -threshold]) {
      const y = Math.round(plot.valToPos(value, "y", true));
      ctx.beginPath();
      ctx.moveTo(bbox.left, y);
      ctx.lineTo(bbox.left + bbox.width, y);
      ctx.stroke();
      ctx.fillText(`${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}°`, bbox.left + 5, y - 4);
    }
    ctx.restore();
  }] } };
}

const palette = ["#52d1db", "#f0c674", "#d09cf1", "#ff879b", "#7ddc84", "#62a8ff", "#f39c5a", "#b8e36b", "#cc7fff", "#66d0a6", "#ffcf5b", "#8f9dff"];

if (typeof module !== "undefined") module.exports = TrendCharts;
