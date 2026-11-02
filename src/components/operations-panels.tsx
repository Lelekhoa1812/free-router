"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Clock3, Database, Gauge, HardDrive, Radio, RefreshCw, ShieldCheck, Zap } from "lucide-react";

const MB = 1_000_000;
const ATLAS_FREE_CAPACITY = 512 * MB;
const APP_STORAGE_TARGET = 320 * MB;

type CollectionStat = { name: string; count: number; sizeBytes: number; indexBytes: number };
type StorageSnapshot = { database: string; dataBytes: number; indexBytes: number; collections: CollectionStat[]; collectionStatsComplete: boolean; observedAt: string };

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < MB) return `${(value / 1000).toFixed(0)} KB`;
  return `${(value / MB).toFixed(1)} MB`;
}

function formatDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function Metric({ label, value, detail, icon: Icon, tone = "neutral" }: { label: string; value: string; detail: string; icon: typeof Database; tone?: string }) {
  return <article className={`panel ops-metric ${tone}`}><div className="ops-metric-head"><span>{label}</span><Icon size={17} aria-hidden="true" /></div><strong>{value}</strong><small>{detail}</small></article>;
}

export function StoragePanel() {
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  async function load() {
    if (requestRef.current) return;
    const aborter = new AbortController();
    requestRef.current = aborter;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/storage", { cache: "no-store", signal: aborter.signal });
      if (!response.ok) throw new Error(response.status === 503 ? "MongoDB storage statistics are temporarily unavailable." : "Could not load storage statistics.");
      const data = await response.json() as StorageSnapshot;
      setSnapshot(data);
      setError("");
      setLastChecked(new Date());
    } catch (cause) {
      if (!aborter.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load storage statistics.");
    } finally {
      if (requestRef.current === aborter) requestRef.current = null;
      if (!aborter.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => {
      window.clearInterval(timer);
      const activeRequest = requestRef.current;
      requestRef.current = null;
      activeRequest?.abort();
    };
  }, []);

  const usedBytes = snapshot ? snapshot.dataBytes + snapshot.indexBytes : null;
  const usedPct = usedBytes === null ? 0 : Math.min(100, usedBytes / ATLAS_FREE_CAPACITY * 100);
  const budgetPct = usedBytes === null ? 0 : usedBytes / APP_STORAGE_TARGET * 100;
  const overTarget = usedBytes !== null && usedBytes > APP_STORAGE_TARGET;
  const nearClusterLimit = usedPct >= 90;
  const collections = useMemo(() => [...(snapshot?.collections || [])].sort((a, b) => (b.sizeBytes + b.indexBytes) - (a.sizeBytes + a.indexBytes)), [snapshot]);
  const biggest = collections[0];
  const documentCount = collections.reduce((count, collection) => count + collection.count, 0);

  return <div className="storage-page">
    <section className="panel storage-capacity" aria-labelledby="storage-capacity-title">
      <div className="storage-capacity-copy">
        <div className="storage-section-kicker"><HardDrive size={14} /> MONGODB · {snapshot?.database || "FreeRouter database"}</div>
        <div className="storage-capacity-title-row"><div><h2 id="storage-capacity-title">Database footprint</h2><p>Measured data and index sizes from the live MongoDB database.</p></div><div className="storage-capacity-actions"><span className={`storage-health ${error ? "is-error" : loading ? "is-pending" : overTarget || nearClusterLimit ? "is-warning" : ""}`}><i aria-hidden="true" />{error ? snapshot ? "Stale sample" : "Stats unavailable" : loading ? snapshot ? "Refreshing sample" : "Connecting" : nearClusterLimit ? "Near cluster limit" : overTarget ? "Above app target" : "Live measurement"}</span><button className="button storage-refresh" onClick={() => void load()} disabled={loading}><RefreshCw size={13} className={loading ? "spin-icon" : ""} />{loading ? "Refreshing" : "Refresh stats"}</button></div></div>
        {error && <div className="storage-inline-error" role="alert">{error} <button className="text-button" onClick={() => void load()}>Retry</button></div>}
        <div className={`capacity-track ${overTarget ? "over-target" : ""} ${nearClusterLimit ? "near-limit" : ""}`} role="img" aria-label={snapshot ? `MongoDB uses ${formatBytes(usedBytes!)} of 512 MB, ${usedPct.toFixed(1)} percent` : error ? "MongoDB storage usage unavailable" : "Loading MongoDB storage usage"}><span style={{ width: `${usedPct}%` }} /></div>
        <div className="capacity-labels"><span><b>{formatBytes(usedBytes ?? Number.NaN)}</b>{snapshot ? ` used · ${usedPct.toFixed(1)}%` : " usage"}</span><span>512 MB free-cluster ceiling</span></div>
        <div className={`storage-budget ${overTarget ? "over-target" : ""}`}><span>Application target</span><div className="budget-track" role="img" aria-label={snapshot ? `Application target usage is ${budgetPct.toFixed(1)} percent` : "Application target utilization unavailable"}><span style={{ width: `${Math.min(100, budgetPct)}%` }} /></div><b>{snapshot ? `${budgetPct.toFixed(0)}% · ${formatBytes(APP_STORAGE_TARGET)}` : formatBytes(APP_STORAGE_TARGET)}</b></div>
        <small className="storage-measured-at">{lastChecked ? `${error ? "Last successful sample" : "Measured"} ${lastChecked.toLocaleTimeString()}${error ? " · stale" : ""}` : "Waiting for first measurement"}{snapshot?.observedAt ? ` · database sample ${new Date(snapshot.observedAt).toLocaleTimeString()}` : ""}</small>
      </div>
      <div className="storage-footprint-number"><span>DATA + INDEXES</span><strong>{formatBytes(usedBytes ?? Number.NaN)}</strong><small>of 512 MB cluster capacity</small></div>
    </section>

    <div className="storage-metrics">
      <Metric label="Document data" value={formatBytes(snapshot?.dataBytes ?? Number.NaN)} detail="MongoDB dbStats · uncompressed" icon={Database} />
      <Metric label="Indexes" value={formatBytes(snapshot?.indexBytes ?? Number.NaN)} detail="Included in free-tier storage" icon={Gauge} tone="blue" />
      <Metric label="Collections" value={snapshot ? String(collections.length) : "—"} detail={snapshot?.collectionStatsComplete ? `${documentCount.toLocaleString()} documents measured` : snapshot ? "Partial collection stats" : "Document count unknown"} icon={Activity} tone="green" />
      <Metric label="Largest collection" value={biggest ? formatBytes(biggest.sizeBytes + biggest.indexBytes) : "—"} detail={biggest?.name || "No collection data yet"} icon={HardDrive} tone="amber" />
    </div>

    <section className="panel section-card storage-collections">
      <div className="section-title"><div><h2>Collection footprint</h2><p>Data and indexes by collection · sorted by combined size</p></div><span className="storage-refresh-note">{loading ? "Refreshing…" : lastChecked ? `Updated ${lastChecked.toLocaleTimeString()}` : "Waiting for data"}</span></div>
      {snapshot && collections.length > 0 ? <><div className="table-wrap"><table><thead><tr><th>Collection</th><th>Documents</th><th>Data</th><th>Indexes</th><th>Total</th><th>Share</th></tr></thead><tbody>{collections.map((collection) => {
        const total = collection.sizeBytes + collection.indexBytes;
        const share = usedBytes ? total / usedBytes * 100 : 0;
        return <tr key={collection.name}><td><b className="mono">{collection.name}</b></td><td>{collection.count.toLocaleString()}</td><td>{formatBytes(collection.sizeBytes)}</td><td>{formatBytes(collection.indexBytes)}</td><td><b>{formatBytes(total)}</b></td><td><div className="collection-share"><span><i style={{ width: `${share}%` }} /></span><small>{share.toFixed(1)}%</small></div></td></tr>;
      })}</tbody></table></div>{!snapshot.collectionStatsComplete && <div className="storage-partial-note" role="status">Some collection statistics could not be read; totals above use the database-wide sample.</div>}</> : <div className="storage-empty">{error ? "Collection measurements could not be loaded." : loading ? "Loading collection measurements…" : snapshot ? "No collections exist yet; database-wide usage is still measured." : "No collection data is available yet."}</div>}
    </section>

    <div className="storage-lower-grid">
      <section className="panel section-card">
        <div className="section-title"><div><h2>Retention & cleanup</h2><p>Expired records are removed by the daily bounded maintenance job.</p></div><Clock3 size={17} /></div>
        <div className="retention-list">
          <div><span>Stored Responses state</span><b>24 hours · logical expiry</b></div>
          <div><span>Request metadata</span><b>7 days · cleanup target</b></div>
          <div><span>Audit and probe history</span><b>30 days · cleanup target</b></div>
          <div><span>Debug content capture</span><b className="retention-unavailable">Not implemented</b></div>
        </div>
        <div className="maintenance-summary"><span><i aria-hidden="true" /> Daily schedule · 16:00 UTC</span><small>Last-run counts are not currently retained.</small></div>
        <div className="info-banner"><ShieldCheck size={16} /><span>Ordinary request metadata omits prompt and answer content. Response state is inaccessible after logical expiry; physical cleanup runs asynchronously.</span></div>
      </section>
      <section className="panel section-card">
        <div className="section-title"><div><h2>Coordination store</h2><p>Upstash Redis holds short-lived admission and coordination state.</p></div><Zap size={17} /></div>
      <div className="coordination-summary"><div><span>Supplied database capacity</span><b>64 MiB</b></div><div><span>Gateway coordination target</span><b>&lt;16 MiB</b></div><div><span>Live memory usage</span><b className="muted">Not sampled</b></div><div><span>Redis command/bandwidth metrics</span><b className="muted">Not exposed</b></div></div>
      <div className="info-banner"><Radio size={16} /><span>Admission counters use bounded windows and expiring leases. The supplied limit and gateway target are configuration values, not measured current usage.</span></div>
      </section>
    </div>
  </div>;
}

type PlaygroundProps = { models: any[]; onDone: (id: string) => void };
type RunMetrics = { requestId?: string; resolvedModel?: string; provider?: string; attempts?: number; durationMs?: number; ttftMs?: number | null; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; finishReason?: string };

export function Playground({ models, onDone }: PlaygroundProps) {
  const [model, setModel] = useState("fr-code");
  const [prompt, setPrompt] = useState("Write a small TypeScript function that groups an array of records by a key.");
  const [maxTokens, setMaxTokens] = useState(1024);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("Ready to send");
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!busy || startedAt === null) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);

  async function run() {
    if (!prompt.trim() || busy) return;
    setBusy(true); setAnswer(""); setMetrics(null); setError(""); setPhase("Connecting to an eligible provider…");
    const started = Date.now(); setStartedAt(started); setElapsed(0);
    const aborter = new AbortController(); abortRef.current = aborter;
    try {
      const response = await fetch("/api/admin/playground", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: maxTokens, stream: true }), signal: aborter.signal });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error?.message || `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || "";
        for (const frame of frames) {
          const eventName = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
          const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (!dataLine) continue;
          if (eventName === "heartbeat") continue;
          const data = JSON.parse(dataLine);
          if (eventName === "status") { setPhase(data.message || "Running"); setMetrics((current) => ({ ...current, requestId: data.requestId || current?.requestId, resolvedModel: data.resolvedModel || current?.resolvedModel, provider: data.provider || current?.provider, attempts: data.attempt ?? current?.attempts })); }
          if (eventName === "delta") { setPhase("Generating response"); setAnswer((current) => current + (data.content || "")); }
          if (eventName === "complete") { setMetrics(data); setPhase("Completed"); onDone(data.requestId || "playground"); }
          if (eventName === "failure") { setMetrics((current) => ({ ...current, requestId: data.requestId || current?.requestId, resolvedModel: data.resolvedModel || current?.resolvedModel, provider: data.provider || current?.provider, attempts: data.attempts ?? current?.attempts, durationMs: data.durationMs ?? current?.durationMs })); throw new Error(data.message || "The upstream request failed."); }
        }
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") setPhase("Cancelled");
      else { setError(cause instanceof Error ? cause.message : "Request failed."); setPhase("Failed"); }
    } finally { abortRef.current = null; setElapsed(Date.now() - started); setStartedAt(null); setBusy(false); }
  }

  const generationWindowMs = metrics?.durationMs !== undefined && metrics?.ttftMs != null ? metrics.durationMs - metrics.ttftMs : null;
  const throughput = metrics?.usage?.completion_tokens != null && generationWindowMs !== null && generationWindowMs > 0 ? metrics.usage.completion_tokens / (generationWindowMs / 1000) : null;
  const readyModels = useMemo(() => models.filter((entry) => entry.status === "ready"), [models]);
  const cancelled = !busy && phase === "Cancelled";

  return <div className="playground-layout">
    <section className="play-composer" aria-labelledby="play-composer-title">
      <div className="play-section-title"><div><span className="ops-kicker">LIVE INFERENCE</span><h3 id="play-composer-title">Compose a request</h3><p>Run a real streamed Chat Completions request through FreeRouter.</p></div><span className="stream-enabled"><i aria-hidden="true" /> Upstream streaming on</span></div>
      <div className="play-controls">
        <label className="play-control">Model or alias<select className="field" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>{["fr-auto", "fr-fast", "fr-code", "fr-quality", "fr-vision", ...readyModels.map((entry) => entry.id)].filter((value, index, array) => array.indexOf(value) === index).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="play-control token-control">Output budget <span className="token-field"><input className="field" type="number" min={16} max={8192} step={128} value={maxTokens} onChange={(event) => setMaxTokens(Math.min(8192, Math.max(16, Number(event.target.value) || 16)))} disabled={busy} /><small>tokens max</small></span></label>
      </div>
      <label className="play-control prompt-control">Prompt <textarea className="field prompt-area" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask a question or describe a coding task…" disabled={busy} /></label>
      <div className="play-submit-row"><p><ShieldCheck size={14} /> Real provider quota is used. Prompt content is not added to ordinary request logs.<small>{prompt.length.toLocaleString()} characters · {readyModels.length} text models enabled</small></p>{busy ? <button className="button play-submit stop-request" onClick={() => { setPhase("Cancelling request…"); abortRef.current?.abort(); }}><span className="stop-square" /> Stop request</button> : <button className="button primary play-submit" onClick={() => void run()} disabled={!prompt.trim()}><Radio size={15} /> Send streamed request</button>}</div>
      {error && <div className="play-error" role="alert">{error}</div>}
    </section>
    <aside className="play-inspector" aria-labelledby="play-inspector-title">
      <div className="play-inspector-head"><div><span className="ops-kicker">OBSERVABILITY</span><h3 id="play-inspector-title">Run inspector</h3></div><span className={`run-state ${error ? "failed" : busy ? "running" : cancelled ? "idle" : metrics ? "complete" : "idle"}`}><i aria-hidden="true" />{error ? "Failed" : busy ? "In progress" : cancelled ? "Cancelled" : metrics ? "Complete" : "Idle"}</span></div>
      <div className="run-phase"><span className={busy ? "phase-pulse" : "phase-dot"} aria-hidden="true" />{phase}<small>{busy ? formatDuration(elapsed) : metrics ? formatDuration(metrics.durationMs || 0) : "—"}</small></div>
      <div className="run-metrics-grid"><div><span>Time to first token</span><b>{formatDuration(metrics?.ttftMs ?? null)}</b></div><div><span>Total duration</span><b>{metrics?.durationMs != null ? formatDuration(metrics.durationMs) : busy ? formatDuration(elapsed) : "—"}</b></div><div><span>Approx. output rate</span><b>{throughput != null ? `${throughput.toFixed(1)} tok/s` : "—"}</b></div><div><span>Input tokens</span><b>{metrics?.usage?.prompt_tokens != null ? metrics.usage.prompt_tokens.toLocaleString() : "—"}</b></div><div><span>Output tokens</span><b>{metrics?.usage?.completion_tokens != null ? metrics.usage.completion_tokens.toLocaleString() : "—"}</b></div><div><span>Total tokens</span><b>{metrics?.usage?.total_tokens != null ? metrics.usage.total_tokens.toLocaleString() : "—"}</b></div></div>
      <p className="usage-note">Token counts are provider-reported; unavailable usage and rates are shown as —.</p>
      <div className="run-route"><span>Resolved model</span><b className="mono">{metrics?.resolvedModel || (busy ? model : "Awaiting request")}</b></div>
      <div className="run-route"><span>Provider / attempts</span><b>{metrics?.provider || "—"}{metrics?.attempts != null ? ` · ${metrics.attempts} upstream ${metrics.attempts === 1 ? "attempt" : "attempts"}` : ""}</b></div>
      <div className="run-route"><span>Finish reason</span><b>{metrics?.finishReason || "Not available"}</b></div>
      <div className="run-route"><span>Request ID</span><b className="mono">{metrics?.requestId || "Assigned at admission"}</b></div>
      <div className="answer-panel"><div className="answer-panel-head"><span>STREAMED OUTPUT</span>{busy && <span className="answer-live"><i aria-hidden="true" /> Receiving tokens</span>}</div><pre aria-live="polite" aria-label="Model response">{answer || (busy ? "Waiting for the first model token…" : "The model response will appear here as it streams.")}</pre></div>
    </aside>
  </div>;
}
