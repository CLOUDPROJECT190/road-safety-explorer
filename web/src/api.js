// Thin client for the Functions API. The base URL is injected at build time.
const BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");

async function request(path, options) {
  const res = await fetch(`${BASE}/api${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const getMeta = () => request("/meta");
export const listJobs = () => request("/jobs");
export const getJob = (id) => request(`/jobs/${id}`);
export const getResult = (id) => request(`/jobs/${id}/result`);
export const createJob = (years, mode, label = "") =>
  request("/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ years, mode, label }),
  });

// Submit a job and poll until it finishes, reporting each status change.
export async function runJob(years, mode, onUpdate, label) {
  const { job_id } = await createJob(years, mode, label);
  onUpdate({ job_id, status: "Queued", mode });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const job = await getJob(job_id);
    onUpdate(job);
    if (job.status === "Complete") return job;
    if (job.status === "Failed") throw new Error(job.error || "The analysis failed");
  }
}
