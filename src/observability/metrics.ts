/**
 * Minimal Prometheus-compatible metrics registry. Kept dependency-free and
 * allocation-light: counters and gauges are plain maps keyed by serialized
 * label sets, rendered to text only when scraped.
 */
type Labels = Record<string, string>;

/** A metric's stable name and human-readable help text, declared once. */
export interface MetricDef {
  name: string;
  help: string;
}

function keyOf(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return "{" + keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",") + "}";
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

interface Series {
  labels: Labels;
  value: number;
}

class Metric {
  readonly series = new Map<string, Series>();
  constructor(readonly name: string, readonly help: string, readonly type: "counter" | "gauge") {}

  add(labels: Labels, delta: number): void {
    const k = keyOf(labels);
    const existing = this.series.get(k);
    if (existing) existing.value += delta;
    else this.series.set(k, { labels, value: delta });
  }

  set(labels: Labels, value: number): void {
    this.series.set(keyOf(labels), { labels, value });
  }
}

export class Metrics {
  private readonly metrics = new Map<string, Metric>();

  private metric(name: string, help: string, type: "counter" | "gauge"): Metric {
    let m = this.metrics.get(name);
    if (!m) {
      m = new Metric(name, help, type);
      this.metrics.set(name, m);
    }
    return m;
  }

  /** Increments a counter defined by a {@link MetricDef}. */
  count(def: MetricDef, labels: Labels = {}, delta = 1): void {
    this.metric(def.name, def.help, "counter").add(labels, delta);
  }

  /** Sets a gauge defined by a {@link MetricDef}. */
  gauge(def: MetricDef, value: number, labels: Labels = {}): void {
    this.metric(def.name, def.help, "gauge").set(labels, value);
  }

  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics.values()) {
      lines.push(`# HELP ${m.name} ${m.help}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
      for (const s of m.series.values()) {
        lines.push(`${m.name}${renderLabels(s.labels)} ${s.value}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
