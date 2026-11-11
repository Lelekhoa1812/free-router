"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { formatTokenCount, viewModels, type ContextBand, type ModelSortKey, type ModelTask, type RegistryModel } from "@/lib/models/registry-view";

const STATUSES = ["ready", "experimental", "unavailable", "restricted"] as const;
const TASKS: { id: ModelTask; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "tools", label: "Tools" },
  { id: "schema", label: "Schema" },
  { id: "vision", label: "Vision" },
];
const BANDS: { id: ContextBand; label: string }[] = [
  { id: "any", label: "Any size" },
  { id: "compact", label: "Under 128k" },
  { id: "standard", label: "128k–256k" },
  { id: "long", label: "256k–1M" },
  { id: "million", label: "1M+" },
  { id: "unknown", label: "Unknown" },
];

function Badge({ value }: { value: string }) {
  const tone = /ready|passed|active|healthy|completed/i.test(value) ? "green" : /failed|invalid|unavailable|revoked|error/i.test(value) ? "red" : /unknown|warming|experimental|partial|restricted/i.test(value) ? "amber" : "blue";
  return <span className={`badge ${tone}`}><span className="dot" />{value}</span>;
}

export function ModelsPanel({ models }: { models: RegistryModel[] }) {
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [tasks, setTasks] = useState<ModelTask[]>([]);
  const [contextBand, setContextBand] = useState<ContextBand>("any");
  const [sortKey, setSortKey] = useState<ModelSortKey>("label");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const providerOptions = useMemo(
    () => [...new Set(models.map((model) => model.provider))].sort(),
    [models],
  );
  const rows = useMemo(
    () => viewModels(models, { search, statuses, providers, tasks, contextBand, sortKey, sortDirection }),
    [models, search, statuses, providers, tasks, contextBand, sortKey, sortDirection],
  );

  function toggle<T extends string>(current: T[], value: T, set: (next: T[]) => void) {
    set(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function sort(key: ModelSortKey) {
    if (sortKey === key) setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDirection(key === "context" || key === "maxOutput" ? "desc" : "asc");
    }
  }

  return (
    <section className="panel section-card">
      <div className="section-title">
        <div>
          <h2>Model registry</h2>
          <p>Advertised capability and preliminary probe status</p>
        </div>
        <div className="search-box">
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models" aria-label="Search models" />
        </div>
      </div>

      <div className="models-filters">
        <div className="filter-row" role="group" aria-label="Status">
          {STATUSES.map((status) => (
            <button key={status} type="button" className={`filter-chip ${statuses.includes(status) ? "active" : ""}`} aria-pressed={statuses.includes(status)} onClick={() => toggle(statuses, status, setStatuses)}>
              {status} <small>{models.filter((model) => model.status === status).length}</small>
            </button>
          ))}
        </div>
        <div className="filter-row" role="group" aria-label="Provider">
          {providerOptions.map((provider) => (
            <button key={provider} type="button" className={`filter-chip ${providers.includes(provider) ? "active" : ""}`} aria-pressed={providers.includes(provider)} onClick={() => toggle(providers, provider, setProviders)}>
              <span className="capitalize">{provider}</span> <small>{models.filter((model) => model.provider === provider).length}</small>
            </button>
          ))}
        </div>
        <div className="filter-row" role="group" aria-label="Task">
          {TASKS.map((task) => (
            <button key={task.id} type="button" className={`filter-chip ${tasks.includes(task.id) ? "active" : ""}`} aria-pressed={tasks.includes(task.id)} onClick={() => toggle(tasks, task.id, setTasks)}>
              {task.label}
            </button>
          ))}
        </div>
        <div className="filter-row" role="group" aria-label="Context size">
          {BANDS.map((band) => (
            <button key={band.id} type="button" className={`filter-chip ${contextBand === band.id ? "active" : ""}`} aria-pressed={contextBand === band.id} onClick={() => setContextBand(band.id)}>
              {band.label}
            </button>
          ))}
        </div>
      </div>

      <p className="models-count">{rows.length} of {models.length} models</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Model" sortKey="label" active={sortKey} direction={sortDirection} onSort={sort} />
              <SortHeader label="Provider" sortKey="provider" active={sortKey} direction={sortDirection} onSort={sort} />
              <SortHeader label="Context" sortKey="context" active={sortKey} direction={sortDirection} onSort={sort} />
              <SortHeader label="Output" sortKey="maxOutput" active={sortKey} direction={sortDirection} onSort={sort} />
              <th>Text</th><th>Tools</th><th>Schema</th><th>Vision</th>
              <SortHeader label="Status" sortKey="status" active={sortKey} direction={sortDirection} onSort={sort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((model) => (
              <tr key={model.id}>
                <td><b>{model.label}</b><small className="table-sub mono">{model.id}</small></td>
                <td><span className="capitalize">{model.provider}</span></td>
                <td>{formatTokenCount(model.context)}</td>
                <td>{formatTokenCount(model.maxOutput)}</td>
                <td><Badge value={model.text} /></td>
                <td><Badge value={model.tools} /></td>
                <td><Badge value={model.schema} /></td>
                <td><Badge value={model.vision} /></td>
                <td><Badge value={model.status} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9}><span className="muted">No models match these filters.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortHeader({ label, sortKey, active, direction, onSort }: { label: string; sortKey: ModelSortKey; active: ModelSortKey; direction: "asc" | "desc"; onSort: (key: ModelSortKey) => void }) {
  const selected = active === sortKey;
  const Icon = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th aria-sort={selected ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`sort-header ${selected ? "active" : ""}`} onClick={() => onSort(sortKey)}>
        {label} {selected && <Icon size={11} />}
      </button>
    </th>
  );
}
