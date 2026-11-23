import React, { useEffect, useMemo, useState } from "react";
import { getMeta, getResult, listJobs, runJob } from "./api.js";
import { BarList, ChartCard, ColumnChart } from "./charts.jsx";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SEVERITY = { 1: "Fatal", 2: "Serious", 3: "Slight" };
const STEPS = ["Queued", "Running", "Complete"];

// Flex Consumption on-demand meters (USD). Compute only; see the README.
const PRICE_GB_SECOND = 0.000026;
const PRICE_MILLION_EXECUTIONS = 0.4;

const fmt = (n) => n.toLocaleString("en-GB");
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : 0;
};
const sameYears = (a, b) => a.length === b.length && a.every((y, i) => y === b[i]);

function estimatedExecutions(job) {
  const m = job.metrics;
  const activities = job.years.length + m.count_activity_executions + 1;
  const episodes = 3 + (job.mode === "sequential" ? m.partitions : 1);
  return activities + episodes + 1;
}

function Stepper({ job }) {
  if (!job) return null;
  const failed = job.status === "Failed";
  const current = STEPS.indexOf(job.status);
  return (
    <div className="stepper" aria-live="polite">
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          {i > 0 && <span className={`step-line${i <= current ? " done" : ""}`} />}
          <span className={`step${i < current || job.status === "Complete" ? " done" : i === current ? " active" : ""}`}>
            <span className="dot" />
            {s}
          </span>
        </React.Fragment>
      ))}
      <span className="muted step-detail">
        {failed
          ? `Failed: ${job.error || "see logs"}`
          : job.status === "Running" && job.progress
            ? `${job.progress.stage}${job.progress.total ? ` (${job.progress.done} of ${job.progress.total})` : ""}`
            : job.status === "Complete" && job.metrics
              ? `${job.mode} run finished in ${job.metrics.total_seconds.toFixed(2)} s`
              : `${job.mode} run`}
      </span>
    </div>
  );
}

function Comparison({ jobs, years }) {
  const groups = useMemo(() => {
    const out = {};
    for (const mode of ["sequential", "parallel"]) {
      const js = jobs.filter((j) => j.mode === mode && sameYears(j.years, years));
      if (!js.length) continue;
      const gbs = median(js.map((j) => j.metrics.estimated_gb_seconds));
      const execs = median(js.map(estimatedExecutions));
      out[mode] = {
        runs: js.length,
        counting: median(js.map((j) => j.metrics.counting_seconds)),
        total: median(js.map((j) => j.metrics.total_seconds)),
        activities: js[0].metrics.count_activity_executions,
        execs,
        gbs,
        cost: gbs * PRICE_GB_SECOND + (execs / 1e6) * PRICE_MILLION_EXECUTIONS,
        workers: Math.max(...js.map((j) => j.metrics.distinct_workers)),
        checksums: new Set(js.map((j) => j.result.checksum)),
      };
    }
    return out;
  }, [jobs, years]);

  const { sequential: seq, parallel: par } = groups;
  if (!seq || !par) {
    return (
      <p className="muted">
        No comparison yet for {years.join(", ")}. Choose “Run comparison” to run the same analysis sequentially and in
        parallel.
      </p>
    );
  }
  const allSums = new Set([...seq.checksums, ...par.checksums]);
  const speedup = seq.counting / par.counting;
  const row = (label, f) => (
    <tr>
      <th scope="row">{label}</th>
      <td>{f(seq)}</td>
      <td>{f(par)}</td>
    </tr>
  );
  return (
    <>
      <div className="compare-grid">
        <div>
          <h4>Median counting-stage runtime</h4>
          <BarList
            unit="seconds"
            format={(v) => `${v.toFixed(2)} s`}
            data={[
              { key: "seq", label: "Sequential", value: seq.counting, series: 1 },
              { key: "par", label: "Parallel", value: par.counting, series: 2 },
            ]}
          />
          <p className="callout">
            {speedup >= 1
              ? `Parallel was ${speedup.toFixed(2)}× faster on this workload.`
              : `Parallel was ${(1 / speedup).toFixed(2)}× slower on this workload: coordination overhead outweighed the benefit.`}
          </p>
        </div>
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col">Median per run</th>
              <th scope="col">Sequential</th>
              <th scope="col">Parallel</th>
            </tr>
          </thead>
          <tbody>
            {row("Runs recorded", (g) => g.runs)}
            {row("Counting-stage runtime", (g) => `${g.counting.toFixed(2)} s`)}
            {row("End-to-end runtime", (g) => `${g.total.toFixed(2)} s`)}
            {row("Count activity executions", (g) => g.activities)}
            {row("Estimated function executions", (g) => g.execs)}
            {row("Estimated compute", (g) => `${g.gbs.toFixed(3)} GB-s`)}
            {row("Estimated compute cost", (g) => `$${g.cost.toFixed(7)}`)}
            {row("Most worker instances in a run", (g) => g.workers)}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Outputs {allSums.size === 1 ? "are identical" : "DIFFER"} across both modes (result checksum{" "}
        {allSums.size === 1 ? <code>{[...allSums][0].slice(0, 12)}</code> : "mismatch"}). Cost is an estimate of Functions
        compute only, before the monthly free grant; storage and monitoring are billed separately.
      </p>
    </>
  );
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [year, setYear] = useState(null);
  const [allYears, setAllYears] = useState(false);
  const [mode, setMode] = useState("parallel");
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [la, setLa] = useState("all");
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);

  const refreshJobs = () => listJobs().then((r) => setJobs(r.jobs)).catch(() => {});

  useEffect(() => {
    getMeta()
      .then((m) => {
        setMeta(m);
        setYear(m.years.includes(2023) ? 2023 : m.years[m.years.length - 1]);
      })
      .catch((e) => setError(`Could not reach the API: ${e.message}`));
    refreshJobs();
  }, []);

  const years = useMemo(() => (meta && allYears ? meta.years : year ? [year] : []), [meta, allYears, year]);

  async function run(modes) {
    setBusy(true);
    setError(null);
    try {
      let last;
      for (const m of modes) {
        last = await runJob(years, m, setJob, modes.length > 1 ? "comparison" : "");
      }
      setResult(await getResult(last.job_id));
      setLa("all");
      await refreshJobs();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const view = useMemo(() => {
    if (!result) return null;
    const { rows, local_authorities } = result.summary;
    const laName = Object.fromEntries(local_authorities.map((a) => [a.code, a.name]));
    const bySev = { 1: 0, 2: 0, 3: 0 };
    const byMonth = new Map();
    const byLa = new Map();
    for (const [y, m, code, sev, n] of rows) {
      byLa.set(code, (byLa.get(code) || 0) + n);
      if (la !== "all" && code !== la) continue;
      bySev[sev] += n;
      const key = `${y}-${String(m).padStart(2, "0")}`;
      byMonth.set(key, (byMonth.get(key) || 0) + n);
    }
    const yearsInResult = result.job.years;
    const multi = yearsInResult.length > 1;
    const monthly = [];
    for (const y of yearsInResult) {
      for (let m = 1; m <= 12; m++) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        monthly.push({
          key,
          label: `${MONTHS[m - 1]} ${y}`,
          tick: multi ? (m === 1 ? String(y) : "") : MONTHS[m - 1],
          value: byMonth.get(key) || 0,
        });
      }
    }
    const total = bySev[1] + bySev[2] + bySev[3];
    const severity = [1, 2, 3].map((s) => ({
      key: s,
      label: SEVERITY[s],
      value: bySev[s],
      note: total ? `(${((bySev[s] / total) * 100).toFixed(1)}%)` : "",
    }));
    const top = [...byLa.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, n]) => ({ key: code, label: laName[code] || code, value: n }));
    return { total, bySev, monthly, severity, top, laName, yearsInResult };
  }, [result, la]);

  const scopeLabel = view ? (la === "all" ? "Great Britain" : view.laName[la]) : "";
  const period = view ? view.yearsInResult.join(", ") : "";

  return (
    <div className="viz-root">
      <header className="page-header">
        <h1>Road Safety Explorer</h1>
        <p className="muted">
          Police-reported personal-injury road collisions in Great Britain, from the Department for Transport STATS19
          open data.
        </p>
      </header>

      <section className="card controls">
        <label>
          Year
          <select value={year ?? ""} onChange={(e) => setYear(Number(e.target.value))} disabled={busy || allYears || !meta}>
            {(meta?.years || []).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label>
          Execution mode
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy}>
            <option value="parallel">Parallel (fan-out/fan-in)</option>
            <option value="sequential">Sequential</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={allYears} onChange={(e) => setAllYears(e.target.checked)} disabled={busy} />
          All years ({meta ? `${meta.years[0]} to ${meta.years[meta.years.length - 1]}` : "…"}), larger workload
        </label>
        <div className="actions">
          <button className="primary" onClick={() => run([mode])} disabled={busy || !years.length}>
            {busy ? "Running…" : "Run Analysis"}
          </button>
          <button onClick={() => run(["sequential", "parallel"])} disabled={busy || !years.length}>
            Run comparison
          </button>
        </div>
        <Stepper job={job} />
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {view && (
        <>
          <section className="filters">
            <label>
              Local authority
              <select value={la} onChange={(e) => setLa(e.target.value)}>
                <option value="all">All of Great Britain</option>
                {result.summary.local_authorities.map((a) => (
                  <option key={a.code} value={a.code}>{a.name}</option>
                ))}
              </select>
            </label>
            {la !== "all" && <button onClick={() => setLa("all")}>Clear filter</button>}
          </section>

          <section className="tiles">
            <div className="tile">
              <span className="tile-label">Reported injury collisions</span>
              <span className="tile-value">{fmt(view.total)}</span>
              <span className="muted">{scopeLabel}, {period}</span>
            </div>
            {[1, 2, 3].map((s) => (
              <div className="tile" key={s}>
                <span className="tile-label">{SEVERITY[s]}</span>
                <span className="tile-value">{fmt(view.bySev[s])}</span>
                <span className="muted">collisions by worst injury</span>
              </div>
            ))}
          </section>

          <div className="chart-grid">
            <ChartCard
              title="Reported injury collisions by month"
              subtitle={`${scopeLabel}, ${period}`}
              table={{ columns: ["Month", "Collisions"], rows: view.monthly.map((d) => [d.label, d.value]) }}
            >
              <ColumnChart data={view.monthly} />
            </ChartCard>

            <ChartCard
              title="Collisions by severity"
              subtitle={`${scopeLabel}, ${period}. Severity is that of the most seriously injured casualty.`}
              table={{ columns: ["Severity", "Collisions"], rows: view.severity.map((d) => [d.label, d.value]) }}
            >
              <BarList data={view.severity} />
            </ChartCard>

            <ChartCard
              title="Ten local authorities with the most reported collisions"
              subtitle={`Great Britain, ${period}. Raw counts, not adjusted for traffic or population, so not a ranking of road risk. Select a bar to filter.`}
              table={{ columns: ["Local authority", "Collisions"], rows: view.top.map((d) => [d.label, d.value]) }}
            >
              <BarList data={view.top} onSelect={setLa} selectedKey={la} />
            </ChartCard>
          </div>

          <section className="card provenance">
            <h3>Where these numbers came from</h3>
            <p className="muted">{result.summary.scope_note}</p>
            <table>
              <thead>
                <tr>
                  <th>Year</th><th>Dataset version</th><th>Input records</th><th>Accepted</th><th>Excluded</th><th>Source</th>
                </tr>
              </thead>
              <tbody>
                {result.job.datasets.map((d) => {
                  const reasons = Object.entries(d.rejected_by_reason).filter(([, n]) => n > 0);
                  return (
                    <tr key={d.year}>
                      <td>{d.year}</td>
                      <td><code>{d.dataset_version}</code></td>
                      <td>{fmt(d.input_records)}</td>
                      <td>{fmt(d.accepted_records)}</td>
                      <td>
                        {reasons.length
                          ? reasons.map(([r, n]) => `${fmt(n)} ${r.replaceAll("_", " ")}`).join("; ")
                          : "none"}
                      </td>
                      <td><a href={d.source_url}>DfT CSV</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted">
              Job <code>{result.job.job_id.slice(0, 8)}</code> ({result.job.mode}). Summary counts{" "}
              {result.summary.reconciliation.match ? "add up to" : "DO NOT add up to"} the{" "}
              {fmt(result.summary.reconciliation.accepted_input_records)} accepted input records. Result checksum{" "}
              <code>{result.summary.checksum.slice(0, 12)}</code>.
            </p>
          </section>
        </>
      )}

      <section className="card">
        <h3>Sequential versus parallel</h3>
        <p className="muted">
          The same activities over the same monthly partitions, dispatched one at a time or all at once
          {years.length ? ` (${years.length * 12} partitions for ${years.join(", ")})` : ""}.
        </p>
        <Comparison jobs={jobs} years={years} />
      </section>
    </div>
  );
}
