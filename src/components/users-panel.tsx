"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Mail, Plus, RefreshCw, ShieldCheck, Trash2, UsersRound } from "lucide-react";

type UserRecord = { email: string; createdAt?: string };
type UsersPayload = { users?: Array<string | UserRecord>; password?: string; rotatedAt?: string | null; lastSentAt?: string | null };

function normalizeUsers(value: UsersPayload["users"]): UserRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => typeof entry === "string" ? { email: entry } : entry).filter((entry) => typeof entry?.email === "string");
}

export function UsersPanel() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [password, setPassword] = useState("");
  const [rotatedAt, setRotatedAt] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store", signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not load authorized users.");
      const payload = data as UsersPayload;
      setUsers(normalizeUsers(payload.users));
      setPassword(typeof payload.password === "string" ? payload.password : "");
      setRotatedAt(payload.rotatedAt ?? null);
      setLastSentAt(payload.lastSentAt ?? null);
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load authorized users.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function addUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!normalized || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: normalized }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not add this email.");
      setEmail(""); setNotice(data.delivery === "failed" ? `${normalized} was added, but the password email could not be delivered. Use Refresh password to retry delivery.` : `${normalized} was added as a password email recipient.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this email."); }
    finally { setSaving(false); }
  }

  async function removeUser(user: UserRecord) {
    if (!window.confirm(`Remove ${user.email} from the password email list? They will not receive future password emails.`)) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/users", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: user.email }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not remove this email.");
      setNotice(`${user.email} was removed.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove this email."); }
    finally { setSaving(false); }
  }

  async function rotatePassword() {
    if (rotating || !window.confirm(`Generate a new six-digit password and email it to all ${users.length} password recipient${users.length === 1 ? "" : "s"}? The current password will stop working immediately.`)) return;
    setRotating(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/users/rotate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not rotate the password.");
      if (typeof data.password === "string") setPassword(data.password);
      setRotatedAt(data.rotatedAt ?? new Date().toISOString());
      setLastSentAt(data.lastSentAt ?? new Date().toISOString());
      const sent = typeof data.sent === "number" ? data.sent : users.length;
      const failed = Array.isArray(data.failed) ? data.failed.length : 0;
      setNotice(failed ? `Password changed. Sent to ${sent}; ${failed} email${failed === 1 ? "" : "s"} failed.` : `Password changed and sent to ${sent} password recipient${sent === 1 ? "" : "s"}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rotate the password."); }
    finally { setRotating(false); }
  }

  async function copyPassword() {
    if (!password) return;
    try { await navigator.clipboard.writeText(password); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
    catch { setError("Clipboard access was unavailable. Select and copy the password manually."); }
  }

  return <div className="users-page">
    <section className="panel users-password-card" aria-labelledby="users-password-heading">
      <div className="users-password-top">
        <div className="users-password-copy"><span className="users-kicker"><ShieldCheck size={13}/> SHARED ADMIN ACCESS</span><h2 id="users-password-heading">Current sign-in password</h2><p>This six-digit password is shared with every authorized email address. Keep it within your trusted group.</p></div>
        <button type="button" className="button users-rotate-button" onClick={() => void rotatePassword()} disabled={rotating || loading || users.length === 0} aria-busy={rotating} title={users.length ? "Generate and email a new password" : "Add an authorized email first"}><RefreshCw size={14} className={rotating ? "users-spin" : ""}/>{rotating ? "Sending…" : "Refresh password"}</button>
      </div>
      <div className="users-password-row">
        {loading ? <div className="users-password-loading" role="status">Loading current password…</div> : password ? <><code className="users-password-value" aria-label="Current six-digit sign-in password">{password}</code><button type="button" className="icon-button users-copy-button" aria-label={copied ? "Password copied" : "Copy current password"} onClick={() => void copyPassword()}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button><span className="users-copy-label" role="status" aria-live="polite">{copied ? "Copied" : "Copy"}</span></> : <span className="users-password-unavailable">Password unavailable</span>}
      </div>
      <div className="users-password-meta"><span>{rotatedAt ? <>Last rotated <time dateTime={rotatedAt}>{new Date(rotatedAt).toLocaleString()}</time></> : "Password rotation time unavailable"}</span><span>{lastSentAt ? <>Last email <time dateTime={lastSentAt}>{new Date(lastSentAt).toLocaleString()}</time></> : "No delivery recorded"}</span></div>
      <p className="users-rotation-note"><Mail size={14}/> Refreshing immediately invalidates the current password and sends the new code to every listed recipient.</p>
    </section>

    <section className="panel section-card users-list-card" aria-labelledby="authorized-users-heading">
      <div className="section-title users-list-heading"><div><div className="users-title-line"><UsersRound size={16}/><h2 id="authorized-users-heading">Password email recipients</h2><span className="users-count">{users.length}</span></div><p>Manage which addresses receive the shared password. With two or more recipients, sign-in needs only the password.</p></div></div>
      <form className="users-add-form" onSubmit={(event) => void addUser(event)}>
        <label className="users-email-label" htmlFor="authorized-email">Email address</label>
        <div className="users-add-controls"><input id="authorized-email" className="field" type="email" autoComplete="email" maxLength={254} placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required/><button className="button primary users-add-button" type="submit" disabled={saving || loading || !email.trim()}>{saving ? <span className="button-spinner"/> : <Plus size={14}/>}Add email</button></div>
      </form>
      {error && <div className="users-alert error" role="alert">{error}<button type="button" className="text-button" onClick={() => void load()}>Try again</button></div>}
      {notice && <div className="users-alert success" role="status"><Check size={14}/>{notice}</div>}
      {loading ? <div className="users-list-state" role="status">Loading authorized recipients…</div> : users.length === 0 ? <div className="users-empty"><div className="users-empty-icon"><Mail size={17}/></div><b>No authorized recipients</b><p>Add an email address before generating and sending a shared access password.</p></div> : <div className="table-wrap users-table-wrap"><table className="users-table"><thead><tr><th>Email address</th><th>Added</th><th aria-label="Actions"/></tr></thead><tbody>{users.map((user) => <tr key={user.email}><td><span className="users-email-cell">{user.email}</span></td><td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : <span className="muted">—</span>}</td><td className="users-actions-cell"><button type="button" className="users-remove-button" disabled={saving} onClick={() => void removeUser(user)} aria-label={`Remove ${user.email}`}><Trash2 size={13}/><span>Remove</span></button></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
