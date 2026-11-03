"use client";

import { useEffect, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";

interface QuotaSnapshot {
  available: boolean;
  used: { requestsDay: number; requestsMinute: number; tokensDay: number; tokensMinute: number };
  remaining: {
    requestsDay: number | null;
    requestsMinute: number | null;
    tokensDay: number | null;
    tokensMinute: number | null;
  };
  resetAt: string | null;
}

interface QuotaRow {
  model: string;
  label: string;
  limits: { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
  snapshot: QuotaSnapshot;
}

interface QuotaGroup {
  id: string;
  label: string;
  slots: number[];
  scope: "group" | "model";
  timeZone: string;
  rows: QuotaRow[];
}

interface QuotaProvider {
  id: string;
  label: string;
  groups: QuotaGroup[];
}

interface QuotaData {
  available: boolean;
  mode: "off" | "observe" | "enforce";
  generatedAt: string;
  warnings: string[];
  providers: QuotaProvider[];
}

function value(value: number | undefined): string {
  return value === undefined || value === 0 ? "Not set" : value.toLocaleString();
}

function remaining(value: number | null, limit: number | undefined): string {
  if (!limit) return "Observed only";
  if (value === null) return "—";
  return value.toLocaleString();
}

function reset(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

const modeLabel = { off: "Off", observe: "Observe only", enforce: "Enforced" } as const;

export function QuotaPanel() {
  const [data, setData] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/quota", { cache: "no-store" });
      if (!response.ok) throw new Error("Quota data is unavailable");
      setData(await response.json());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Quota data is unavailable");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (loading && !data) {
    return <section className="panel section-card"><div className="empty-state"><Gauge size={22} /><b>Loading quota</b><span>Reading configured limits and current counters…</span></div></section>;
  }

  if (error && !data) {
    return <section className="panel section-card"><div className="warning-banner"><Gauge size={16} /><span>{error}</span></div></section>;
  }

  return (
    <div className="quota-page">
      <section className="panel section-card">
        <div className="section-title">
          <div>
            <h2>Quota routing</h2>
            <p>Operator-declared provider limits; counters are live Redis values.</p>
          </div>
          <button className="button small-button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        <div className="quota-summary">
          <span className={`badge ${data?.mode === "enforce" ? "green" : data?.mode === "observe" ? "amber" : "blue"}`}>
            <span className="dot" /> {modeLabel[data?.mode ?? "observe"]}
          </span>
          <span className="muted">Generated {data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : "—"}</span>
          {!data?.available && <span className="badge red"><span className="dot" /> Counters unavailable</span>}
        </div>
        {!data?.available && (
          <div className="warning-banner">
            <Gauge size={16} />
            <span>Redis counters could not be read. Configured limits are shown, but usage and remaining values are not current.</span>
          </div>
        )}
        {!!data?.warnings.length && (
          <ul className="quota-warnings">
            {data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}
      </section>

      {(data?.providers ?? []).map((provider) => (
        <section className="panel section-card" key={provider.id}>
          <div className="section-title">
            <div>
              <h2>{provider.label}</h2>
              <p>Quota groups follow the real provider account or project boundary.</p>
            </div>
          </div>
          {provider.groups.map((group) => (
            <div className="quota-group" key={`${provider.id}:${group.id}`}>
              <div className="quota-group-head">
                <div>
                  <b>{group.label}</b>
                  <small className="muted">
                    {group.scope === "group" ? "Account-wide" : "Per model"} · keys {group.slots.join(", ")} · {group.timeZone}
                  </small>
                </div>
                <span className="badge blue"><span className="dot" /> {group.id}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>RPM</th>
                      <th>RPD</th>
                      <th>Requests today</th>
                      <th>Remaining today</th>
                      <th>Tokens today</th>
                      <th>Reset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => (
                      <tr key={`${group.id}:${row.model}`}>
                        <td><b>{row.label}</b><small className="table-sub mono">{row.model === "*" ? "all free models" : row.model}</small></td>
                        <td>{value(row.limits.rpm)}</td>
                        <td>{value(row.limits.rpd)}</td>
                        <td>{row.snapshot.used.requestsDay.toLocaleString()}</td>
                        <td>{remaining(row.snapshot.remaining.requestsDay, row.limits.rpd)}</td>
                        <td>{!row.limits.tpd ? "Observed only" : `${row.snapshot.used.tokensDay.toLocaleString()} / ${row.limits.tpd.toLocaleString()}`}</td>
                        <td>{reset(row.snapshot.resetAt)}</td>
                      </tr>
                    ))}
                    {!group.rows.length && (
                      <tr><td colSpan={7}><span className="muted">No ready models in this group.</span></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
