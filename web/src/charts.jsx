import React, { useRef, useState } from "react";

const fmt = (n) => n.toLocaleString("en-GB");

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function useTooltip() {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const show = (e, content) => {
    const box = ref.current.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, content });
  };
  const node = tip && (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.content}
    </div>
  );
  return { ref, show, hide: () => setTip(null), node };
}

export function ChartCard({ title, subtitle, children, table }) {
  return (
    <section className="card chart-card">
      <h3>{title}</h3>
      {subtitle && <p className="muted">{subtitle}</p>}
      {children}
      {table && (
        <details className="table-view">
          <summary>View as table</summary>
          <table>
            <thead>
              <tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{typeof c === "number" ? fmt(c) : c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

// Vertical bars for change over time. data: [{ key, label, tick, value }]
export function ColumnChart({ data, unit = "collisions", height = 260 }) {
  const { ref, show, hide, node } = useTooltip();
  const W = 720, H = height, m = { t: 12, r: 8, b: 28, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const band = iw / Math.max(data.length, 1);
  const bw = Math.max(2, Math.min(40, band - 2));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const y = (v) => m.t + ih - (v / max) * ih;

  return (
    <div className="chart" ref={ref} onMouseLeave={hide}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bar chart of ${unit} over time`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={m.l - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = m.l + i * band + (band - bw) / 2;
          const h = Math.max(0, (d.value / max) * ih);
          const r = Math.min(4, bw / 2, h);
          const top = m.t + ih - h;
          return (
            <g key={d.key}>
              {h > 0 && (
                <path
                  className="bar"
                  d={`M${x},${m.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${m.t + ih} Z`}
                />
              )}
              <rect
                className="hit"
                x={m.l + i * band} y={m.t} width={band} height={ih}
                onMouseMove={(e) => show(e, <><strong>{d.label}</strong><br />{fmt(d.value)} {unit}</>)}
              />
              {d.tick && (
                <text className="axis" x={x + bw / 2} y={H - 8} textAnchor="middle">{d.tick}</text>
              )}
            </g>
          );
        })}
        <line className="baseline" x1={m.l} x2={W - m.r} y1={m.t + ih} y2={m.t + ih} />
      </svg>
      {node}
    </div>
  );
}

// Horizontal bars with direct value labels, for comparing named categories.
// data: [{ key, label, value, note, series }]
export function BarList({ data, unit = "collisions", format = fmt, onSelect, selectedKey }) {
  const { ref, show, hide, node } = useTooltip();
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div className="chart barlist" ref={ref} onMouseLeave={hide}>
      {data.map((d) => {
        const Row = onSelect ? "button" : "div";
        return (
          <Row
            key={d.key}
            className={`barlist-row${selectedKey === d.key ? " selected" : ""}`}
            onClick={onSelect ? () => onSelect(d.key) : undefined}
            onMouseMove={(e) => show(e, <><strong>{d.label}</strong><br />{format(d.value)} {unit}{d.note ? <><br />{d.note}</> : null}</>)}
            type={onSelect ? "button" : undefined}
          >
            <span className="barlist-label">{d.label}</span>
            <span className="barlist-track">
              <span
                className={`barlist-fill series-${d.series || 1}`}
                style={{ width: `${Math.max((d.value / max) * 100, d.value > 0 ? 0.6 : 0)}%` }}
              />
            </span>
            <span className="barlist-value">{format(d.value)}{d.note ? <span className="muted"> {d.note}</span> : null}</span>
          </Row>
        );
      })}
      {node}
    </div>
  );
}
