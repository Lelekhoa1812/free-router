"use client";
import { useState } from "react";
import { LockKeyhole, ArrowRight } from "lucide-react";
export function LoginPage() {
  const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(""); try { const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }); if (!r.ok) throw new Error("That password did not match."); location.reload(); } catch (e) { setError(e instanceof Error ? e.message : "Unable to sign in"); } finally { setBusy(false); } }
  return <main className="login-shell"><div className="login-card panel"><div className="brand-mark">FR</div><div className="eyebrow">PRIVATE GATEWAY</div><h1>Welcome to FreeRouter</h1><p className="muted">Enter the admin password to manage your model gateway.</p><form onSubmit={submit}><label htmlFor="password">Admin password</label><input id="password" className="field" type="password" autoComplete="current-password" autoFocus value={password} onChange={e => setPassword(e.target.value)} required />{error && <p className="error-text">{error}</p>}<button className="button primary full" disabled={busy}>{busy ? "Signing in…" : "Continue"}<ArrowRight size={16}/></button></form><div className="login-foot"><LockKeyhole size={14}/> Session protected · 12 hour expiry</div></div><p className="login-caption">FreeRouter <span>·</span> Unified model operations</p></main>;
}
