"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Activity, ArrowDownToLine, Braces, Check, Clock3, Code2, Copy, Database, Eye, Gauge, HardDrive, Layers3, Radio, RefreshCw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { MarkdownPreview } from "@/components/markdown-preview";
import { buildDecisionPlaygroundBody, buildEmbeddingPlaygroundBody, buildEmbeddingPlaygroundInput, extractPlaygroundModels, type PlaygroundQuestionType, type PlaygroundServiceModel } from "@/lib/playground";

const MB = 1_000_000;
const ATLAS_FREE_CAPACITY = 512 * MB;
const APP_STORAGE_TARGET = 320 * MB;

type CollectionStat = { name: string; count: number; sizeBytes: number; indexBytes: number };
type StorageSnapshot = { database: string; dataBytes: number; indexBytes: number; collections: CollectionStat[]; collectionStatsComplete: boolean; coordination?: { status: "available" | "unavailable"; keyCount: number | null; pingMs: number | null; sampledAt: string }; observedAt: string };

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
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
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
      <div className="coordination-summary"><div><span>Supplied database capacity</span><b>64 MiB</b></div><div><span>Gateway coordination target</span><b>&lt;16 MiB</b></div><div><span>Redis database keys</span><b className={snapshot?.coordination?.status === "available" ? "" : "muted"}>{snapshot?.coordination?.status === "available" ? snapshot.coordination.keyCount?.toLocaleString() ?? "—" : "Unavailable"}</b></div><div><span>Redis round-trip</span><b className={snapshot?.coordination?.pingMs != null ? "" : "muted"}>{snapshot?.coordination?.pingMs != null ? formatDuration(snapshot.coordination.pingMs) : "—"}</b></div></div>
      <div className="info-banner"><Radio size={16} /><span>Redis key count and PING round-trip are sampled live; key count covers the supplied Redis database, while memory and billing metrics are not exposed by this endpoint. Admission counters use bounded windows and expiring leases.</span></div>
      </section>
    </div>
  </div>;
}

type PlaygroundProps = { models: any[]; onDone: (id: string) => void };
type RunMetrics = { requestId?: string; resolvedModel?: string; provider?: string; attempts?: number; durationMs?: number; ttftMs?: number | null; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; finishReason?: string };

type PlaygroundMode = "chat" | "decisions" | "embeddings";

export function Playground({ models, onDone }: PlaygroundProps) {
  const [mode, setMode] = useState<PlaygroundMode>("chat");
  return <div className="playground-workbench">
    <div className="playground-modebar" role="tablist" aria-label="Playground endpoint type">
      <button type="button" role="tab" id="play-tab-chat" aria-selected={mode === "chat"} aria-controls="play-panel" className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}><Code2 size={14} /> Chat & Responses <span>LLM</span></button>
      <button type="button" role="tab" id="play-tab-decisions" aria-selected={mode === "decisions"} aria-controls="play-panel" className={mode === "decisions" ? "active" : ""} onClick={() => setMode("decisions")}><Sparkles size={14} /> Decisions <span>Jev</span></button>
      <button type="button" role="tab" id="play-tab-embeddings" aria-selected={mode === "embeddings"} aria-controls="play-panel" className={mode === "embeddings" ? "active" : ""} onClick={() => setMode("embeddings")}><Layers3 size={14} /> Embeddings <span>Vectors</span></button>
    </div>
    <div id="play-panel" role="tabpanel" aria-labelledby={`play-tab-${mode}`}>
      {mode === "chat" ? <ChatPlayground models={models} onDone={onDone} /> : mode === "decisions" ? <DecisionPlayground onDone={onDone} /> : <EmbeddingPlayground onDone={onDone} />}
    </div>
  </div>;
}

function ChatPlayground({ models, onDone }: PlaygroundProps) {
  const [model, setModel] = useState("fr-code");
  const [prompt, setPrompt] = useState("Write a small TypeScript function that groups an array of records by a key.");
  const [maxTokens, setMaxTokens] = useState(1024);
  const [answer, setAnswer] = useState("");
  const [outputMode, setOutputMode] = useState<"raw" | "preview">("raw");
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
      <div className="run-metrics-grid"><div><span>Time to first token</span><b>{formatDuration(metrics?.ttftMs ?? null)}</b></div><div><span>Total duration</span><b>{metrics?.durationMs != null ? formatDuration(metrics.durationMs) : busy ? formatDuration(elapsed) : "—"}</b></div><div><span>Approx. output rate</span><b>{throughput != null ? `${throughput.toFixed(1)} tok/s` : "—"}</b></div><div><span>Input tokens</span><b>{metrics?.usage?.prompt_tokens != null ? metrics.usage.prompt_tokens.toLocaleString() : "—"}</b></div><div><span>Output tokens</span><b>{metrics?.usage?.completion_tokens != null ? metrics.usage.completion_tokens.toLocaleString() : "—"}</b></div><div><span>Total tokens</span><b>{metrics?.usage?.total_tokens != null ? metrics.usage.total_tokens.toLocaleString() : "—"}</b></div><div><span>Output characters</span><b>{answer ? Array.from(answer).length.toLocaleString() : busy ? "Streaming…" : "—"}</b></div></div>
      <p className="usage-note">Token counts are provider-reported; unavailable usage and rates are shown as —.</p>
      <div className="run-route"><span>Resolved model</span><b className="mono">{metrics?.resolvedModel || (busy ? model : "Awaiting request")}</b></div>
      <div className="run-route"><span>Provider / attempts</span><b>{metrics?.provider || "—"}{metrics?.attempts != null ? ` · ${metrics.attempts} upstream ${metrics.attempts === 1 ? "attempt" : "attempts"}` : ""}</b></div>
      <div className="run-route"><span>Finish reason</span><b>{metrics?.finishReason || "Not available"}</b></div>
      <div className="run-route"><span>Request ID</span><b className="mono">{metrics?.requestId || "Assigned at admission"}</b></div>
      <div className="answer-panel"><div className="answer-panel-head"><span>STREAMED OUTPUT</span><div className="answer-panel-actions">{busy && <span className="answer-live"><i aria-hidden="true" /> Receiving tokens</span>}<div className="output-mode-switch" role="group" aria-label="Output display mode"><button type="button" aria-label="Raw output" title="Raw output" aria-pressed={outputMode === "raw"} onClick={() => setOutputMode("raw")}><Code2 size={13} aria-hidden="true" /></button><button type="button" aria-label="Preview output" title="Preview output" aria-pressed={outputMode === "preview"} onClick={() => setOutputMode("preview")}><Eye size={13} aria-hidden="true" /></button></div></div></div>{outputMode === "raw" ? <pre aria-live="polite" aria-label="Raw model response">{answer || (busy ? "Waiting for the first model token…" : "The model response will appear here as it streams.")}</pre> : answer ? <MarkdownPreview content={answer} /> : <div className="markdown-empty">{busy ? "Waiting for the first model token…" : "The formatted model response will appear here as it streams."}</div>}</div>
    </aside>
  </div>;
}

type ServiceRun = { requestId?: string; model?: string; provider?: string; durationMs?: number; usage?: Record<string, unknown>; [key: string]: unknown };

function useServiceModels(path: string, fallback: PlaygroundServiceModel[] = []) {
  const [models, setModels] = useState<PlaygroundServiceModel[]>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(path, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message || `Model discovery failed (${response.status})`);
      const rows = extractPlaygroundModels(data);
      if (rows.length) setModels(rows);
      setError("");
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Model discovery is unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path]);
  return { models, loading, error };
}

function useRunClock(busy: boolean, startedAt: number | null) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy || startedAt === null) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);
  return elapsed;
}

function PlaygroundHeader({ kicker, title, description, status }: { kicker: string; title: string; description: string; status?: string }) {
  return <div className="play-section-title"><div><span className="ops-kicker">{kicker}</span><h3>{title}</h3><p>{description}</p></div>{status && <span className="endpoint-protocol"><i aria-hidden="true" />{status}</span>}</div>;
}

function ServiceInspector({ title, busy, error, phase, startedAt, metrics, requestId, output, children }: { title: string; busy: boolean; error: string; phase: string; startedAt: number | null; metrics: ServiceRun | null; requestId?: string; output?: string; children?: ReactNode }) {
  const elapsed = useRunClock(busy, startedAt);
  const duration = metrics?.durationMs ?? (busy && startedAt ? elapsed : null);
  const status = error ? "failed" : busy ? "running" : metrics ? "complete" : "idle";
  return <aside className="play-inspector" aria-label={`${title} run inspector`}>
    <div className="play-inspector-head"><div><span className="ops-kicker">RUN DETAILS</span><h3>{title}</h3></div><span className={`run-state ${status}`}><i aria-hidden="true" />{error ? "Failed" : busy ? "In progress" : metrics ? "Complete" : "Idle"}</span></div>
    <div className="run-phase"><span className={busy ? "phase-pulse" : "phase-dot"} aria-hidden="true" />{phase}<small>{formatDuration(duration ?? null)}</small></div>
    <div className="run-metrics-grid"><div><span>Duration</span><b>{formatDuration(duration ?? null)}</b></div><div><span>Provider</span><b>{metrics?.provider || "—"}</b></div><div><span>Model</span><b className="mono">{metrics?.model || "—"}</b></div><div><span>Request ID</span><b className="mono">{requestId || metrics?.requestId || "—"}</b></div></div>
    {children}
    {error && <div className="play-error" role="alert">{error}</div>}
    <div className="answer-panel"><div className="answer-panel-head"><span>{output ? "RESPONSE" : "RESPONSE PREVIEW"}</span></div><pre aria-live="polite">{output || (busy ? "Waiting for response…" : "Your result will appear here after a request.")}</pre></div>
  </aside>;
}

function DecisionPlayground({ onDone }: { onDone: (id: string) => void }) {
  const { models, loading, error: modelsError } = useServiceModels("/api/admin/playground/decision/models", [{ id: "jev/jev-latest", name: "Jev Latest" }, { id: "jev/jev-preview", name: "Jev Preview" }]);
  const [protocol, setProtocol] = useState<"decisions" | "systemone">("decisions");
  const [model, setModel] = useState("jev/jev-latest");
  const [evidence, setEvidence] = useState("A user reports that the production checkout flow returns a 500 error after payment. They need an urgent fix before today's release.");
  const [question, setQuestion] = useState("Should this be prioritized for an immediate hotfix?");
  const [questionType, setQuestionType] = useState<PlaygroundQuestionType>("predicate");
  const [optionsText, setOptionsText] = useState("Defer\nPrioritize");
  const [rawOutput, setRawOutput] = useState("");
  const [metrics, setMetrics] = useState<ServiceRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("Ready to evaluate");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [jsonBody, setJsonBody] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const elapsed = useRunClock(busy, startedAt);

  useEffect(() => {
    if (!models.some((item) => item.id === model)) setModel(models[0]?.id || "jev/jev-latest");
  }, [models, model]);

  const currentModel = model.replace(/^jev\//, "");
  const options = useMemo(() => optionsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), [optionsText]);
  const decisionBody = useMemo(() => buildDecisionPlaygroundBody(protocol, model, evidence, question, questionType, options), [protocol, model, evidence, question, questionType, options]);

  async function run() {
    if (busy || !evidence.trim() || !question.trim()) return;
    let body: Record<string, unknown>;
    try { body = advanced ? JSON.parse(jsonBody) : decisionBody; }
    catch { setError("Request JSON is invalid. Fix it or switch back to the guided form."); return; }
    if (!advanced && questionType === "choice" && (options.length < 2 || options.length > 255)) { setError("Choice questions need between 2 and 255 options."); return; }
    if (!advanced && questionType === "score" && (options.length < 2 || options.length > 10)) { setError("Score questions need between 2 and 10 ordered levels."); return; }
    const started = Date.now(); setStartedAt(started); setBusy(true); setPhase("Sending decision request…"); setError(""); setMetrics(null); setRawOutput("");
    const aborter = new AbortController(); abortRef.current = aborter;
    try {
      const response = await fetch("/api/admin/playground/decision", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ protocol, model: currentModel, body }), signal: aborter.signal });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error?.message || `Decision request failed (${response.status})`);
      const durationMs = Date.now() - started;
      const runData: ServiceRun = { ...result, durationMs, model: result?.model || model, provider: "Jev" };
      setMetrics(runData); setRawOutput(JSON.stringify(result, null, 2)); setPhase("Decision completed");
      onDone(result?.request_id || result?.requestId || "decision-playground");
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") setPhase("Cancelled");
      else { setError(cause instanceof Error ? cause.message : "Decision request failed."); setPhase("Decision failed"); }
    } finally { abortRef.current = null; setBusy(false); setStartedAt(null); }
  }

  const endpointPath = protocol === "decisions" ? "/v1/decisions" : "/v1/systemone";
  const jsonValue = JSON.stringify(decisionBody, null, 2);
  return <div className="playground-layout" aria-label="Jev Decisions playground">
    <section className="play-composer" aria-label="Jev decision request composer">
      <PlaygroundHeader kicker="JEV DECISIONS" title="Evaluate structured questions" description="Send real evidence to Jev and inspect its native or OpenAI Decisions response." status="Non-streaming API" />
      <div className="play-controls">
        <label className="play-control">Decision protocol<select className="field" value={protocol} onChange={(event) => { const next = event.target.value as typeof protocol; setProtocol(next); setAdvanced(false); }} disabled={busy}><option value="decisions">OpenAI Decisions · /v1/decisions</option><option value="systemone">Native TypeSafe · /v1/systemone</option></select></label>
        <label className="play-control">Jev model<select className="field" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || loading}>{models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label>
      </div>
      {!advanced && <div className="play-controls decision-question-controls"><label className="play-control">Question type<select className="field" value={questionType} onChange={(event) => setQuestionType(event.target.value as PlaygroundQuestionType)} disabled={busy}><option value="predicate">Predicate · yes or no</option><option value="choice">Choice · select an option</option><option value="score">Score · ordered levels</option></select></label><div className="decision-type-hint">{questionType === "predicate" ? "Returns a probability for a yes/no answer." : questionType === "choice" ? "Returns a typed option and its probability distribution." : "Returns an expected score; fractional values are preserved."}</div></div>}
      <label className="play-control prompt-control">Evidence<textarea className="field prompt-area decision-evidence" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="Add the context Jev should evaluate…" disabled={busy || advanced} /></label>
      <label className="play-control prompt-control">Question instructions<textarea className="field decision-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Write a decision question…" disabled={busy || advanced} /></label>
      {!advanced && questionType !== "predicate" && <label className="play-control prompt-control">{questionType === "choice" ? "Options" : "Ordered score levels"}<textarea className="field decision-options" value={optionsText} onChange={(event) => setOptionsText(event.target.value)} placeholder={questionType === "choice" ? "Defer\nPrioritize" : "Low\nMedium\nHigh"} disabled={busy} /><span className="embedding-input-hint">Enter one {questionType === "choice" ? "option" : "level"} per line · {options.length} currently configured</span></label>}
      {advanced && <label className="play-control prompt-control">Raw request body<textarea className="field playground-json-editor" value={jsonBody} onChange={(event) => setJsonBody(event.target.value)} spellCheck={false} disabled={busy} /></label>}
      <div className="play-submit-row"><p><ShieldCheck size={14} /> Uses the existing Jev account credits. No streaming is available on these decision contracts.<small>{modelsError ? `Model discovery unavailable · ${modelsError}` : `${models.length} decision model${models.length === 1 ? "" : "s"} discovered`} · {endpointPath}</small></p>{busy ? <button className="button play-submit stop-request" onClick={() => { setPhase("Cancelling request…"); abortRef.current?.abort(); }}><span className="stop-square" /> Cancel decision</button> : <button className="button primary play-submit" onClick={() => void run()} disabled={!evidence.trim() || !question.trim()}><Sparkles size={15} /> Run decision</button>}</div>
      <div className="playground-advanced-row"><button type="button" className="text-button" aria-expanded={advanced} onClick={() => { if (!advanced) setJsonBody(jsonValue); setAdvanced(!advanced); }}>{advanced ? "Use guided fields" : "Edit raw JSON"}</button><span>{busy ? `Running · ${formatDuration(elapsed)}` : "Evidence is sent only when you run this test."}</span></div>
      {error && <div className="play-error" role="alert">{error}</div>}
    </section>
    <ServiceInspector title="Decision inspector" busy={busy} error={error} phase={phase} startedAt={startedAt} metrics={metrics} requestId={metrics?.requestId} output={rawOutput}>
      <div className="decision-inspector-note"><Braces size={13} /><span>Answers and confidence are shown exactly as returned. Scores may be fractional.</span></div>
    </ServiceInspector>
  </div>;
}

function EmbeddingPlayground({ onDone }: { onDone: (id: string) => void }) {
  const { models, loading, error: modelsError } = useServiceModels("/api/admin/playground/embedding/models");
  const [model, setModel] = useState("");
  const [inputMode, setInputMode] = useState<"single" | "lines">("single");
  const [input, setInput] = useState("FreeRouter converts provider APIs into a consistent interface.");
  const [dimensions, setDimensions] = useState("");
  const [inputType, setInputType] = useState("");
  const [encoding, setEncoding] = useState<"float" | "base64">("float");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("Ready to embed");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const elapsed = useRunClock(busy, startedAt);

  useEffect(() => {
    if (!model && models.length) { setModel(models[0].id); setInputType(models[0].input_type_required ? "query" : ""); }
  }, [models, model]);

  const inputValue = useMemo(() => buildEmbeddingPlaygroundInput(input, inputMode), [input, inputMode]);
  const vector = result?.data?.[0]?.embedding;
  const dimensionCount = Array.isArray(vector) ? vector.length : typeof vector === "string" ? vector.length : null;

  async function run() {
    if (busy || !model || (Array.isArray(inputValue) ? inputValue.length === 0 : !inputValue.trim())) return;
    const started = Date.now(); setStartedAt(started); setBusy(true); setPhase("Sending text to the selected embedding model…"); setError(""); setResult(null); setCopied(false);
    const aborter = new AbortController(); abortRef.current = aborter;
    try {
      const payload = { ...buildEmbeddingPlaygroundBody(model, inputValue, encoding, dimensions), ...(inputType ? { input_type: inputType } : {}) };
      const response = await fetch("/api/admin/playground/embedding", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload), signal: aborter.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message || `Embedding request failed (${response.status})`);
      const durationMs = Date.now() - started;
      const runData = { ...data, durationMs, model: data?.model || model, provider: models.find((item) => item.id === model)?.provider || data?.provider || "—" };
      setResult(runData); setPhase("Embedding completed"); onDone(data?.request_id || data?.requestId || "embedding-playground");
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") setPhase("Cancelled");
      else { setError(cause instanceof Error ? cause.message : "Embedding request failed."); setPhase("Embedding failed"); }
    } finally { abortRef.current = null; setBusy(false); setStartedAt(null); }
  }

  async function copyVector() {
    if (!vector) return;
    await navigator.clipboard.writeText(JSON.stringify(vector)); setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  }

  const summary = result ? JSON.stringify({ object: result.object, model: result.model, count: result.data?.length, dimensions: dimensionCount, usage: result.usage }, null, 2) : "";
  return <div className="playground-layout" aria-label="Embedding playground">
    <section className="play-composer" aria-label="Embedding request composer">
      <PlaygroundHeader kicker="VECTOR EMBEDDINGS" title="Test an explicit embedding model" description="Embedding requests are model-specific. Choose a concrete model; aliases and automatic routing are not used." status="Non-streaming API" />
      <label className="play-control embedding-model-control">Embedding model<select className="field" value={model} onChange={(event) => { const next = event.target.value; setModel(next); setInputType(models.find((item) => item.id === next)?.input_type_required ? "query" : ""); }} disabled={busy || loading}><option value="" disabled>{loading ? "Loading embedding models…" : "Select an embedding model"}</option>{models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label>
      {modelsError && <div className="playground-inline-note" role="status">Model discovery failed: {modelsError}</div>}
      {!loading && !models.length && <div className="playground-empty-models"><Layers3 size={18}/><b>No embedding models are enabled</b><span>Only models with verified embedding support appear here. Check the Endpoints page for model status.</span></div>}
      <div className="play-controls embedding-options">
        <label className="play-control">Input shape<select className="field" value={inputMode} onChange={(event) => setInputMode(event.target.value as typeof inputMode)} disabled={busy}><option value="single">Single text</option><option value="lines">One text per line</option></select></label>
        <label className="play-control">Vector encoding<select className="field" value={encoding} onChange={(event) => setEncoding(event.target.value as typeof encoding)} disabled={busy}><option value="float">Float array</option><option value="base64">Base64</option></select></label>
      </div>
      {models.find((item) => item.id === model)?.input_type_supported === true && <label className="play-control">Retrieval mode{models.find((item) => item.id === model)?.input_type_required === true && <span className="optional-label">Required for this NVIDIA model</span>}<select className="field" value={inputType} onChange={(event) => setInputType(event.target.value)} disabled={busy}><option value="">{models.find((item) => item.id === model)?.input_type_required === true ? "Choose a mode" : "Provider default"}</option><option value="query">query · text to search with</option><option value="passage">passage · text to index</option></select></label>}
      <label className="play-control prompt-control">Input text{inputMode === "lines" && <span className="embedding-input-hint">Each non-empty line is sent as one input item.</span>}<textarea className="field prompt-area embedding-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={inputMode === "lines" ? "First sentence\nSecond sentence" : "Enter the text you want to embed…"} disabled={busy} /></label>
      <div className="play-controls embedding-options">
        <label className="play-control">Dimensions <span className="optional-label">Optional · model-dependent</span><input className="field" type="number" min={1} max={65536} step={1} value={dimensions} onChange={(event) => setDimensions(event.target.value)} placeholder="Use model default" disabled={busy} /></label>
        <div className="play-control embedding-fixed"><span>Endpoint</span><code>POST /v1/embeddings</code><small>Explicit model only · no auto-route</small></div>
      </div>
      <div className="play-submit-row"><p><ShieldCheck size={14} /> Sends {Array.isArray(inputValue) ? inputValue.length : input.trim() ? 1 : 0} input item{Array.isArray(inputValue) && inputValue.length !== 1 || !Array.isArray(inputValue) && input.trim() ? "s" : ""}. The full vector is returned as JSON.<small>{modelsError ? "Model list may be stale" : `${models.length} verified embedding model${models.length === 1 ? "" : "s"}`} · provider quota is used</small></p>{busy ? <button className="button play-submit stop-request" onClick={() => { setPhase("Cancelling request…"); abortRef.current?.abort(); }}><span className="stop-square" /> Cancel request</button> : <button className="button primary play-submit" onClick={() => void run()} disabled={!model || (Array.isArray(inputValue) ? inputValue.length === 0 : !inputValue.trim())}><ArrowDownToLine size={15} /> Create embeddings</button>}</div>
      {busy && <div className="playground-advanced-row"><span>{phase}</span><span>{formatDuration(elapsed)}</span></div>}
      {error && <div className="play-error" role="alert">{error}</div>}
    </section>
    <ServiceInspector title="Embedding inspector" busy={busy} error={error} phase={phase} startedAt={startedAt} metrics={result} requestId={result?.request_id || result?.requestId} output={summary}>
      {result && <div className="embedding-result-summary"><div><span>Vectors</span><b>{result.data?.length ?? "—"}</b></div><div><span>Dimensions</span><b>{dimensionCount ?? (encoding === "base64" ? "base64" : "—")}</b></div><div><span>Input tokens</span><b>{result.usage?.prompt_tokens ?? result.usage?.total_tokens ?? "—"}</b></div><button type="button" className="text-button" onClick={() => void copyVector()} disabled={!vector}>{copied ? <Check size={13}/> : <Copy size={13}/>} {copied ? "Copied vector" : "Copy first vector"}</button></div>}
      {result && <details className="embedding-raw"><summary>Inspect raw OpenAI response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
    </ServiceInspector>
  </div>;
}
