"use client";

import { useRef, useState } from "react";
import { Check, KeyRound, Plus, Radio, RefreshCw, Trash2, X } from "lucide-react";
import { ProviderMark } from "@/components/provider-mark";

type DuplicateSlotRef = { provider: string; providerLabel: string; slot: number; label: string | null };
type Slot = { slot: number; configured: boolean; label: string | null; health: string; paused: boolean; lastSuccessAt: string | null; lastRetestAt: string | null; duplicates?: DuplicateSlotRef[] };
type Provider = { id: string; label: string; configured: number; slots: Slot[] };

function formatDuplicateTooltip(provider: Provider, duplicates: DuplicateSlotRef[]) {
  const targets = duplicates.map((dup) => {
    const slotText = `slot ${String(dup.slot).padStart(2, "0")}`;
    const prefix = dup.provider === provider.id ? "" : `${dup.providerLabel} `;
    return `${prefix}${slotText}${dup.label ? ` (${dup.label})` : ""}`;
  });
  return `Duplicated with: ${targets.join(", ")}`;
}

export function ProviderKeysPanel({ providers, onRefresh, onToast }: { providers: Provider[]; onRefresh: () => Promise<void>; onToast: (message: string) => void }) {
  const [editing, setEditing] = useState<{ provider: Provider; slot: Slot } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<{ providerId: string; slot: number; value: string; initial: string } | null>(null);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const renameGuardRef = useRef(false);

  async function action(provider: Provider, slot: Slot, action: string) {
    if (action === "remove" && !window.confirm(`Remove ${provider.label} key slot ${slot.slot}? Requests will stop using it immediately.`)) return;
    const response = await fetch("/api/admin/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.id, slot: slot.slot, action }) });
    if (!response.ok && action !== "retest") { onToast(`Could not ${action} provider key`); return; }
    const result = action === "retest" ? await response.json().catch(() => ({})) : {};
    await onRefresh();
    onToast(action === "remove" ? "Provider key removed" : action === "retest" ? `Authentication retest: ${result.status || "error"}` : `Key ${action === "pause" ? "paused" : "resumed"}`);
  }

  function startRename(provider: Provider, slot: Slot) {
    if (renamingBusy) return;
    renameGuardRef.current = false;
    const initial = slot.label || `Key slot ${slot.slot}`;
    setRenaming({ providerId: provider.id, slot: slot.slot, value: initial, initial });
  }

  function cancelRename() {
    renameGuardRef.current = true;
    setRenaming(null);
  }

  async function commitRename(provider: Provider, slot: Slot) {
    if (renameGuardRef.current || renamingBusy) return;
    if (!renaming || renaming.providerId !== provider.id || renaming.slot !== slot.slot) return;
    renameGuardRef.current = true;
    const trimmed = renaming.value.trim();
    if (trimmed === renaming.initial.trim() && (slot.label !== null || trimmed === `Key slot ${slot.slot}`)) {
      setRenaming(null);
      return;
    }
    setRenamingBusy(true);
    try {
      const response = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, slot: slot.slot, action: "rename", label: trimmed }),
      });
      if (!response.ok) {
        onToast("Could not rename key slot");
        return;
      }
      setRenaming(null);
      await onRefresh();
      onToast(trimmed ? `Renamed slot ${slot.slot} to "${trimmed}"` : `Reset slot ${slot.slot} name`);
    } catch {
      onToast("Could not reach FreeRouter. Try again.");
    } finally {
      setRenamingBusy(false);
    }
  }

  async function save(formData: FormData) {
    if (!editing || saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/admin/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: editing.provider.id, slot: editing.slot.slot, action: "save", label: formData.get("label"), secret: formData.get("secret") }) });
      const result = await response.json();
      if (!response.ok) { setError(result.error || "Could not save provider key."); return; }
      setEditing(null); await onRefresh();
      onToast(result.health === "healthy" ? "Provider key saved and verified" : `Provider key saved · authentication status: ${result.health}`);
    } catch { setError("Could not reach FreeRouter. Try again."); }
    finally { setSaving(false); }
  }

  return <>
    <section className="panel section-card">
      <div className="section-title"><div><h2>Provider accounts</h2><p>Encrypted key slots are stored in MongoDB. Changes take effect on the next request; double-click any key name to rename it.</p></div></div>
      <div className="provider-cards">{providers.map((provider) => <article className="provider-card" key={provider.id}>
        <div className="provider-card-top"><ProviderMark provider={provider.id}/><div><h3>{provider.label}</h3><p>{provider.configured} configured credentials · slot number preserves account quota grouping</p></div><span className={`badge ${provider.configured ? "green" : "amber"}`}><span className="dot"/>{provider.configured} / {provider.slots.length}</span></div>
        <div className="provider-key-list">{provider.slots.map((slot) => {
          const duplicates = slot.duplicates ?? [];
          const isDuplicated = duplicates.length > 0;
          const duplicateMessage = isDuplicated ? formatDuplicateTooltip(provider, duplicates) : "";
          const isRenaming = renaming?.providerId === provider.id && renaming.slot === slot.slot;
          const displayName = slot.label || `Key slot ${slot.slot}`;
          return <div className={`provider-key-row${isDuplicated ? " is-duplicated" : ""}`} key={slot.slot} title={isDuplicated ? duplicateMessage : undefined}>
            <div className="provider-key-identity">
              <span className="provider-slot-number">{String(slot.slot).padStart(2, "0")}</span>
              <div>
                {isRenaming ? <input
                  className="provider-key-rename-input"
                  value={renaming.value}
                  maxLength={80}
                  autoFocus
                  disabled={renamingBusy}
                  aria-label={`Rename ${provider.label} slot ${slot.slot}`}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); void commitRename(provider, slot); }
                    else if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
                  }}
                  onBlur={() => void commitRename(provider, slot)}
                /> : <b
                  className="provider-key-name"
                  onDoubleClick={() => startRename(provider, slot)}
                  title={isDuplicated ? `${duplicateMessage} · Double-click to rename` : "Double-click to rename"}
                >{displayName}</b>}
                <small>{slot.configured ? `Last success ${slot.lastSuccessAt ? new Date(slot.lastSuccessAt).toLocaleString() : "not yet observed"}` : "No key is stored in this slot"}</small>
              </div>
            </div>
            <span className={`badge ${!slot.configured ? "muted-badge" : slot.health === "healthy" ? "green" : slot.health === "invalid" ? "red" : "amber"}`}><span className="dot"/>{!slot.configured ? "Empty" : slot.paused ? "Paused" : slot.health}</span>
            <div className="provider-key-actions">
              {slot.configured && <button className="icon-button" title="Retest key" aria-label={`Retest ${provider.label} slot ${slot.slot}`} onClick={() => void action(provider, slot, "retest")}><Radio size={14}/></button>}
              {slot.configured && <button className="icon-button" title={slot.paused ? "Resume key" : "Pause key"} aria-label={`${slot.paused ? "Resume" : "Pause"} ${provider.label} slot ${slot.slot}`} onClick={() => void action(provider, slot, slot.paused ? "resume" : "pause")}>{slot.paused ? <Check size={14}/> : <X size={14}/>}</button>}
              <button className="icon-button" title={slot.configured ? "Replace key" : "Add key"} aria-label={`${slot.configured ? "Replace" : "Add"} ${provider.label} slot ${slot.slot}`} onClick={() => { setError(""); setEditing({ provider, slot }); }}><KeyRound size={14}/></button>
              {slot.configured && <button className="icon-button danger-icon" title="Remove key" aria-label={`Remove ${provider.label} slot ${slot.slot}`} onClick={() => void action(provider, slot, "remove")}><Trash2 size={14}/></button>}
            </div>
            {isDuplicated && <span className="provider-duplicate-tooltip" role="tooltip">{duplicateMessage}</span>}
          </div>;
        })}</div>
        <button className="button small-button" onClick={() => { const slot = provider.slots.find((item) => !item.configured); if (slot) { setError(""); setEditing({ provider, slot }); } else onToast("All provider slots are occupied. Replace or remove a key first."); }}><Plus size={14}/> Add to next empty slot</button>
      </article>)}</div>
    </section>
    {editing && <div className="modal-backdrop" role="presentation"><section className="modal panel provider-key-modal" role="dialog" aria-modal="true" aria-labelledby="provider-key-title">
      <div className="modal-title"><div><h2 id="provider-key-title">{editing.slot.configured ? "Replace provider key" : "Add provider key"}</h2><p>{editing.provider.label} · slot {editing.slot.slot}</p></div><button className="icon-button" type="button" aria-label="Close" onClick={() => setEditing(null)}><X size={17}/></button></div>
      <form action={save}><label>Slot label <small>Optional</small></label><input className="field" name="label" maxLength={80} defaultValue={editing.slot.label || ""} placeholder={`${editing.provider.label} account ${editing.slot.slot}`}/><label>Provider API key</label><input className="field" name="secret" type="password" autoComplete="new-password" minLength={1} maxLength={8192} placeholder="Paste the provider key" required/><p className="provider-key-disclosure">FreeRouter checks provider authentication, then encrypts the value before storing it. The secret is never returned to the browser after saving.</p>{error && <p className="error-text" role="alert">{error}</p>}<button className="button primary full" type="submit" disabled={saving}>{saving ? <><RefreshCw size={14} className="spin"/> Checking and saving…</> : <><Check size={14}/> Verify and save</>}</button></form>
    </section></div>}
  </>;
}
