import React, { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { GitCompareArrows, LoaderCircle, Play, X } from "lucide-react";

import { getMeta, getResult, listJobs, runJob } from "./api.js";
import { BarList, ChartCard, MonthlyChart } from "./charts.jsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

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

// Job status drawn as a stretch of road: three signs, and a marker that
// travels between them as the job moves from Queued to Running to Complete.
function RoadProgress({ job }) {
  const status = job?.status;
  const failed = status === "Failed";
  const reached = STEPS.indexOf(status);
  let position = 0;
  if (status === "Running") {
    const p = job.progress;
    const counting = p?.stage?.startsWith("Counting") && p.total;
    position = counting ? 40 + 45 * (p.done / p.total) : p?.stage?.startsWith("Merging") ? 90 : 35;
  } else if (status === "Complete") {
    position = 100;
  }

  const detail = !job
    ? "Nothing running. Choose a year and run the analysis."
    : failed
      ? `The analysis failed: ${job.error || "check the function logs"}`
      : status === "Running" && job.progress
        ? `${job.progress.stage}${job.progress.total ? `, ${job.progress.done} of ${job.progress.total} partitions` : ""}`
        : status === "Complete" && job.metrics
          ? `${job.mode === "parallel" ? "Parallel" : "Sequential"} run complete in ${job.metrics.total_seconds.toFixed(2)} s across ${job.metrics.partitions} partitions`
          : `${job.mode === "parallel" ? "Parallel" : "Sequential"} run ${status === "Running" ? "starting" : "queued"}`;

  return (
    <div>
      <div className="relative mx-12 h-8">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={cn(
              "absolute top-0 -translate-x-1/2 rounded-[5px] border-2 border-white px-2.5 py-0.5 text-sm font-semibold whitespace-nowrap transition-opacity duration-300",
              job && !failed && i <= reached ? "opacity-100" : "opacity-45",
            )}
            style={{ left: `${i * 50}%` }}
          >
            {s}
          </span>
        ))}
      </div>
      <div className="bg-asphalt mt-2 rounded-md px-12 py-[13px]">
        <div className="relative h-[3px]">
          <div className="road-dashes absolute inset-0" data-moving={status === "Running"} />
          {job && !failed && (
            <motion.div
              className="bg-lane absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-[var(--asphalt)]"
              initial={false}
              animate={{ left: `${position}%` }}
              transition={{ type: "spring", stiffness: 70, damping: 18 }}
            />
          )}
        </div>
      </div>
      <p className="mt-2.5 text-sm text-white/85" aria-live="polite">
        {detail}
      </p>
    </div>
  );
}

function Stat({ label, value, note, lead }) {
  return (
    <div className={cn("px-5 py-4", lead && "sm:col-span-2 lg:col-span-1")}>
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className={cn("font-semibold tracking-tight tabular-nums", lead ? "text-4xl" : "text-3xl")}>
        {value > 0 ? <NumberTicker value={value} className="text-foreground tracking-tight" /> : "0"}
      </div>
      <div className="text-muted-foreground text-xs">{note}</div>
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
      <p className="text-muted-foreground text-sm">
        No comparison recorded for {years.join(", ")} yet. Run a comparison to time the same analysis sequentially and
        in parallel.
      </p>
    );
  }
  const allSums = new Set([...seq.checksums, ...par.checksums]);
  const identical = allSums.size === 1;
  const speedup = seq.counting / par.counting;
  const rows = [
    ["Runs recorded", (g) => g.runs],
    ["Counting-stage runtime", (g) => `${g.counting.toFixed(2)} s`],
    ["End-to-end runtime", (g) => `${g.total.toFixed(2)} s`],
    ["Count activity executions", (g) => g.activities],
    ["Estimated function executions", (g) => g.execs],
    ["Estimated compute", (g) => `${g.gbs.toFixed(3)} GB-s`],
    ["Estimated compute cost", (g) => `$${g.cost.toFixed(7)}`],
    ["Most worker instances in a run", (g) => g.workers],
  ];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="min-w-0">
        <p className="text-3xl font-semibold tracking-tight">
          {speedup >= 1 ? `${speedup.toFixed(1)}× faster in parallel` : `${(1 / speedup).toFixed(1)}× slower in parallel`}
        </p>
        <p className="text-muted-foreground mt-1 mb-5 text-sm">
          {speedup >= 1
            ? "Median counting-stage runtime, sequential against parallel."
            : "Coordination overhead outweighed the benefit on this workload."}
        </p>
        <BarList
          unit="seconds"
          format={(v) => `${v.toFixed(2)} s`}
          data={[
            { key: "seq", label: "Sequential", value: seq.counting, series: 1 },
            { key: "par", label: "Parallel", value: par.counting, series: 2 },
          ]}
        />
        <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={identical ? "secondary" : "destructive"}>
            {identical ? "Outputs identical" : "Outputs differ"}
          </Badge>
          {identical && (
            <span className="text-muted-foreground min-w-0 break-words">
              Both modes produced result checksum <code className="text-xs">{[...allSums][0].slice(0, 12)}</code>
            </span>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Median per run</TableHead>
              <TableHead className="text-right">Sequential</TableHead>
              <TableHead className="text-right">Parallel</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([label, f]) => (
              <TableRow key={label}>
                <TableCell>{label}</TableCell>
                <TableCell className="text-right tabular-nums">{f(seq)}</TableCell>
                <TableCell className="text-right tabular-nums">{f(par)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-muted-foreground mt-3 text-xs">
          Cost is an estimate of Functions compute only, before the monthly free grant. Storage and monitoring are
          billed separately.
        </p>
      </div>
    </div>
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
      .catch((e) => setError(`The analysis service could not be reached (${e.message}). Reload the page to try again.`));
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
  const period = view
    ? view.yearsInResult.length > 1
      ? `${view.yearsInResult[0]} to ${view.yearsInResult[view.yearsInResult.length - 1]}`
      : String(view.yearsInResult[0])
    : "";
  const signControl = "border-white/70 bg-white text-[#1d2327] hover:bg-white dark:border-white/70 dark:bg-white dark:hover:bg-white [&_svg]:!text-[#56616b] [&_svg]:!opacity-100";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
      {/* The run panel, drawn as a road sign: this is the one loud element. */}
      <header className="bg-sign text-sign-foreground rounded-2xl p-1.5 shadow-sm">
        <div className="rounded-[11px] border-2 border-white/90 px-5 py-6 sm:px-8 sm:py-7">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Road Safety Explorer</h1>
          <p className="mt-2 max-w-2xl text-white/85">
            Police-reported personal-injury road collisions in Great Britain, from the Department for Transport STATS19
            open data. Run the analysis in the cloud, then explore it by month, severity and local authority.
          </p>

          <div className="mt-6 flex flex-wrap items-end gap-x-5 gap-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="year" className="text-white/85">Year</Label>
              <Select value={year ? String(year) : ""} onValueChange={(v) => setYear(Number(v))} disabled={busy || allYears || !meta}>
                <SelectTrigger id="year" className={cn("w-28", signControl)}>
                  <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent>
                  {(meta?.years || []).map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-white/85">How to run it</Label>
              <Tabs value={mode} onValueChange={setMode}>
                <TabsList className="bg-white/15">
                  <TabsTrigger value="parallel" disabled={busy} className="text-white data-[state=active]:bg-white data-[state=active]:text-[#1d2327] dark:text-white dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-white dark:data-[state=active]:text-[#1d2327]">
                    In parallel
                  </TabsTrigger>
                  <TabsTrigger value="sequential" disabled={busy} className="text-white data-[state=active]:bg-white data-[state=active]:text-[#1d2327] dark:text-white dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-white dark:data-[state=active]:text-[#1d2327]">
                    One at a time
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="flex h-9 items-center gap-2.5">
              <Switch id="all-years" checked={allYears} onCheckedChange={setAllYears} disabled={busy || !meta} className="data-[state=checked]:bg-lane data-[state=unchecked]:bg-white/30" />
              <Label htmlFor="all-years" className="text-white/95">
                All years{meta ? `, ${meta.years[0]} to ${meta.years[meta.years.length - 1]}` : ""}
              </Label>
            </div>

            <div className="flex gap-2 sm:ml-auto">
              <Button onClick={() => run([mode])} disabled={busy || !years.length} className="bg-lane hover:bg-lane/90 font-semibold text-[#1d2327]">
                {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
                {busy ? "Running" : "Run analysis"}
              </Button>
              <Button variant="outline" onClick={() => run(["sequential", "parallel"])} disabled={busy || !years.length} className="border-white/70 bg-transparent text-white hover:bg-white/15 hover:text-white dark:border-white/70 dark:bg-transparent dark:hover:bg-white/15">
                <GitCompareArrows />
                Run comparison
              </Button>
            </div>
          </div>

          <div className="mt-7">
            <RoadProgress job={job} />
          </div>
          {error && (
            <p role="alert" className="mt-3 rounded-md bg-white px-3 py-2 text-sm text-[#a12626]">
              {error}
            </p>
          )}
        </div>
      </header>

      <main className="mt-8 space-y-6">
        {!view && (
          <Card className="border-dashed bg-transparent shadow-none">
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              No results yet. Run the analysis to see collisions by month, severity and local authority.
            </CardContent>
          </Card>
        )}

        {view && (
          <motion.div
            key={result.job.job_id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            className="space-y-6"
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">{scopeLabel}, {period}</h2>
                <p className="text-muted-foreground text-sm">Reported injury collisions. Counts, not rates.</p>
              </div>
              <div className="flex items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="la">Local authority</Label>
                  <Select value={la} onValueChange={setLa}>
                    <SelectTrigger id="la" className="bg-card w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-80">
                      <SelectItem value="all">All of Great Britain</SelectItem>
                      {result.summary.local_authorities.map((a) => (
                        <SelectItem key={a.code} value={a.code}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {la !== "all" && (
                  <Button variant="ghost" onClick={() => setLa("all")}>
                    <X />
                    Clear filter
                  </Button>
                )}
              </div>
            </div>

            <Card className="py-0">
              <div className="divide-border grid divide-y sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
                <Stat lead label="Collisions" value={view.total} note="all severities" />
                {[1, 2, 3].map((s) => (
                  <Stat key={s} label={SEVERITY[s]} value={view.bySev[s]} note="by most serious injury" />
                ))}
              </div>
            </Card>

            <ChartCard
              title="Collisions by month"
              description={`${scopeLabel}, ${period}`}
              table={{ columns: ["Month", "Collisions"], rows: view.monthly.map((d) => [d.label, d.value]) }}
            >
              <MonthlyChart data={view.monthly} />
            </ChartCard>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard
                title="Collisions by severity"
                description={`${scopeLabel}, ${period}. Severity is that of the most seriously injured casualty.`}
                table={{ columns: ["Severity", "Collisions"], rows: view.severity.map((d) => [d.label, d.value]) }}
              >
                <BarList data={view.severity} />
              </ChartCard>

              <ChartCard
                title="Ten local authorities with the most collisions"
                description={`Great Britain, ${period}. Raw counts reflect size and traffic, not road risk. Select a bar to filter the page.`}
                table={{ columns: ["Local authority", "Collisions"], rows: view.top.map((d) => [d.label, d.value]) }}
              >
                <BarList data={view.top} onSelect={setLa} selectedKey={la} />
              </ChartCard>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Where these numbers came from</CardTitle>
                <CardDescription className="max-w-prose">{result.summary.scope_note}</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      <TableHead>Dataset version</TableHead>
                      <TableHead className="text-right">Input records</TableHead>
                      <TableHead className="text-right">Accepted</TableHead>
                      <TableHead>Excluded</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.job.datasets.map((d) => {
                      const reasons = Object.entries(d.rejected_by_reason).filter(([, n]) => n > 0);
                      return (
                        <TableRow key={d.year}>
                          <TableCell>{d.year}</TableCell>
                          <TableCell><code className="text-xs">{d.dataset_version}</code></TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(d.input_records)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(d.accepted_records)}</TableCell>
                          <TableCell>
                            {reasons.length
                              ? reasons.map(([r, n]) => `${fmt(n)} ${r.replaceAll("_", " ")}`).join("; ")
                              : "None"}
                          </TableCell>
                          <TableCell>
                            <a href={d.source_url} className="underline underline-offset-4">DfT collision file</a>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <p className="text-muted-foreground mt-4 text-sm">
                  The summary counts {result.summary.reconciliation.match ? "add up to" : "do not add up to"} the{" "}
                  {fmt(result.summary.reconciliation.accepted_input_records)} accepted input records. Job{" "}
                  <code className="text-xs">{result.job.job_id.slice(0, 8)}</code>, result checksum{" "}
                  <code className="text-xs">{result.summary.checksum.slice(0, 12)}</code>.
                </p>
              </CardContent>
            </Card>
          </motion.div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sequential against parallel</CardTitle>
            <CardDescription className="max-w-prose">
              The same work over the same monthly partitions, dispatched one at a time or all at once
              {years.length ? ` (${years.length * 12} partitions for ${years.length > 1 ? `${years[0]} to ${years[years.length - 1]}` : years[0]})` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Comparison jobs={jobs} years={years} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
