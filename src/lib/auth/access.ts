import { createHash, randomInt } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { getDb } from "@/lib/db";
import { decryptJson, encryptJson, safeCompare } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getRedis } from "@/lib/redis";

const AUTH_ID = "current";
const PASSWORD_AAD = "freerouter:admin-access-password:v1";
type Encrypted = ReturnType<typeof encryptJson>;
type AuthRecord = { _id: string; epoch: number; password?: Encrypted; rotatedAt?: Date; lastSentAt?: Date };
export type AdminUser = { _id?: unknown; email: string; createdAt: Date };

export function normalizeAdminEmail(value: string) { return value.trim().toLowerCase(); }
export function validAdminEmail(value: string) { return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
export function newAccessPassword() { return randomInt(0, 1_000_000).toString().padStart(6, "0"); }
export function uniqueAccessPassword(previous: string | null, generate = newAccessPassword) {
  let code = generate();
  let retries = 0;
  while (previous && code === previous) {
    if (++retries > 20) throw new Error("Unable to generate a new access password");
    code = generate();
  }
  return code;
}
function passwordRecord(code: string) { return encryptJson({ code }, PASSWORD_AAD); }
function readPassword(record: AuthRecord) { return record.password ? decryptJson<{ code: string }>(record.password, PASSWORD_AAD).code : null; }
function smtpReady() { return Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPassword); }

let transporter: Transporter | undefined;
function getTransport() {
  if (!smtpReady() || !env.smtpHost || !env.smtpPort || !env.smtpUser || !env.smtpPassword) throw new Error("SMTP is not configured");
  transporter ??= nodemailer.createTransport({ host: env.smtpHost, port: env.smtpPort, secure: env.smtpPort === 465, requireTLS: env.smtpPort === 587, auth: { user: env.smtpUser, pass: env.smtpPassword.replace(/\s/g, "") }, tls: { minVersion: "TLSv1.2" } });
  return transporter;
}

export async function sendAccessPassword(email: string, code: string) {
  const mail = getTransport();
  await mail.sendMail({ from: `FreeRouter <${env.smtpUser}>`, to: email, subject: "Your FreeRouter access password", text: `Your current FreeRouter access password is: ${code}\n\nEnter your email address and this password at the FreeRouter sign-in page. It remains valid until an administrator rotates it.`, html: `<p>Your current FreeRouter access password is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>Enter your email address and this password at the FreeRouter sign-in page. It remains valid until an administrator rotates it.</p>` });
}

/** Create the initial allowlisted user only from a request for the configured sender mailbox. */
export async function seedBootstrapUser(email: string) {
  if (!env.smtpUser || normalizeAdminEmail(email) !== normalizeAdminEmail(env.smtpUser)) return false;
  const db = await getDb();
  const users = db.collection<AdminUser>("admin_users");
  if (await users.countDocuments({}, { limit: 1 })) return false;
  try { await users.insertOne({ email: normalizeAdminEmail(env.smtpUser), createdAt: new Date() }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  return true;
}

/** Ensure a code exists after initial enrollment, without rotating an existing code. */
export async function ensureInitialPassword() {
  const db = await getDb();
  if (!(await db.collection("admin_users").countDocuments({}, { limit: 1 }))) return { created: false, code: null as string | null };
  const auth = db.collection<AuthRecord>("admin_auth");
  const current = await auth.findOne({ _id: AUTH_ID });
  if (current?.password) return { created: false, code: readPassword(current) };
  const code = newAccessPassword();
  if (!current) {
    try {
      await auth.insertOne({ _id: AUTH_ID, epoch: 1, password: passwordRecord(code), rotatedAt: new Date() });
      return { created: true, code };
    } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  }
  const result = await auth.updateOne({ _id: AUTH_ID, password: { $exists: false } }, { $set: { password: passwordRecord(code), rotatedAt: new Date() }, $inc: { epoch: 1 } });
  if (result.modifiedCount) return { created: true, code };
  const latest = await auth.findOne({ _id: AUTH_ID });
  return { created: false, code: latest ? readPassword(latest) : null };
}

export async function rotateAccessPassword() {
  const db = await getDb();
  const auth = db.collection<AuthRecord>("admin_auth");
  const prior = await auth.findOne({ _id: AUTH_ID });
  const code = uniqueAccessPassword(prior ? readPassword(prior) : null);
  const now = new Date();
  await auth.updateOne({ _id: AUTH_ID }, { $set: { password: passwordRecord(code), rotatedAt: now }, $inc: { epoch: 1 } }, { upsert: true });
  return { code, epoch: (await auth.findOne({ _id: AUTH_ID }))?.epoch ?? 1, rotatedAt: now };
}

export async function currentAccessPassword() {
  const db = await getDb();
  const record = await db.collection<AuthRecord>("admin_auth").findOne({ _id: AUTH_ID });
  return record ? { password: readPassword(record), epoch: record.epoch, rotatedAt: record.rotatedAt ?? null, lastSentAt: record.lastSentAt ?? null } : { password: null, epoch: 0, rotatedAt: null, lastSentAt: null };
}

export async function markPasswordSent(at = new Date()) { const db = await getDb(); await db.collection<AuthRecord>("admin_auth").updateOne({ _id: AUTH_ID }, { $set: { lastSentAt: at } }); }
export async function currentAuthEpoch() { return (await currentAccessPassword()).epoch; }

export async function validAdminPassword(email: string, input: string) {
  if (!/^\d{6}$/.test(input)) return false;
  const db = await getDb();
  const user = await db.collection<AdminUser>("admin_users").findOne({ email: normalizeAdminEmail(email) });
  if (!user) return false;
  const auth = await db.collection<AuthRecord>("admin_auth").findOne({ _id: AUTH_ID });
  const expected = auth ? readPassword(auth) : null;
  return Boolean(expected && safeCompare(input, expected));
}

/** Limit code sends by both caller IP and recipient without disclosing allowlist membership. */
export async function allowCodeSend(ip: string, email: string) {
  const redis = getRedis();
  const recipient = createHash("sha256").update(normalizeAdminEmail(email)).digest("hex").slice(0, 24);
  const keys = [`fr:v1:auth:send:ip:${ip}`, `fr:v1:auth:send:email:${recipient}`];
  const script = `local a=tonumber(redis.call('GET',KEYS[1]) or '0');local b=tonumber(redis.call('GET',KEYS[2]) or '0');if a>=5 or b>=3 then return 0 end;for i=1,2 do local n=redis.call('INCR',KEYS[i]);if n==1 then redis.call('EXPIRE',KEYS[i],3600) end end;return 1`;
  return Number(await redis.eval(script, keys, [])) === 1;
}
export async function loginEmailAllowed(email: string) {
  const recipient = createHash("sha256").update(normalizeAdminEmail(email)).digest("hex").slice(0, 24);
  return Number(await getRedis().get(`fr:v1:auth:login:email:${recipient}`) || 0) < 10;
}
export async function failedEmailLogin(email: string) {
  const recipient = createHash("sha256").update(normalizeAdminEmail(email)).digest("hex").slice(0, 24);
  const key = `fr:v1:auth:login:email:${recipient}`;
  return Number(await getRedis().eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],900) end;return n", [key], []));
}
export async function clearEmailLoginFailures(email: string) {
  const recipient = createHash("sha256").update(normalizeAdminEmail(email)).digest("hex").slice(0, 24);
  await getRedis().del(`fr:v1:auth:login:email:${recipient}`);
}

export async function listAdminUsers() {
  const db = await getDb();
  return db.collection<AdminUser>("admin_users").find({}, { projection: { _id: 0, email: 1, createdAt: 1 } }).sort({ email: 1 }).toArray();
}

export async function addAdminUser(email: string) {
  const normalized = normalizeAdminEmail(email);
  const db = await getDb();
  try { await db.collection<AdminUser>("admin_users").insertOne({ email: normalized, createdAt: new Date() }); return true; }
  catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
}

export async function removeAdminUser(email: string) {
  const db = await getDb();
  return (await db.collection<AdminUser>("admin_users").deleteOne({ email: normalizeAdminEmail(email) })).deletedCount > 0;
}

export async function sendPasswordToAll(code: string) {
  const users = await listAdminUsers();
  const results = await Promise.all(users.map(async ({ email }) => {
    try { await sendAccessPassword(email, code); return { email, ok: true as const }; }
    catch { return { email, ok: false as const }; }
  }));
  const successes = results.filter((result) => result.ok).length;
  if (successes) await markPasswordSent();
  return { sent: successes, failed: results.filter((result) => !result.ok).map((result) => result.email) };
}

export type AdminAuthAudit = {
  action: "admin-user-added" | "admin-user-deleted" | "admin-password-rotated";
  actorEmail: string;
  outcome: string;
  targetEmail?: string;
  targetCount?: number;
  sentCount?: number;
  failedCount?: number;
};
export async function recordAdminAuthAudit(event: AdminAuthAudit) {
  const createdAt = new Date();
  await (await getDb()).collection("audit_events").insertOne({ ...event, createdAt, expiresAt: new Date(createdAt.getTime() + 30 * 86400_000) });
}
