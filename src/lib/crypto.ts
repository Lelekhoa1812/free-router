import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { env } from "@/lib/env";

function secretBytes(value: string | undefined, label: string) {
  if (!value || Buffer.byteLength(value) < 32) throw new Error(`${label} must be configured with at least 32 bytes`);
  return Buffer.from(value);
}
function encryptionKey(value:string|undefined,label:string){return createHash("sha256").update(secretBytes(value,label)).digest()}

export function hashClientKey(token: string) {
  return createHmac("sha256", secretBytes(env.clientKeyHashSecret, "CLIENT_KEY_HASH_SECRET")).update(token).digest("hex");
}

export function safeCompare(a: string, b: string) {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

export function encryptJson(value: unknown, aad: string) {
  const key = encryptionKey(env.stateEncryptionKey,"STATE_ENCRYPTION_KEY");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const raw=Buffer.from(JSON.stringify(value));if(raw.length>8*1024*1024)throw new Error("Encrypted state exceeds the 8 MiB plaintext limit");const compressed=gzipSync(raw);if(compressed.length>4*1024*1024)throw new Error("Encrypted state exceeds the 4 MiB record limit");
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);if(body.length>4*1024*1024)throw new Error("Encrypted state exceeds the 4 MiB record limit");
  return { v: 2, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), body: body.toString("base64url") };
}

export function decryptJson<T>(record: { v: number; nonce: string; tag: string; body: string }, aad: string): T {
  if (record.v !== 1 && record.v !== 2) throw new Error("Unsupported encrypted record version");
  const encrypted=Buffer.from(record.body,"base64url");if(encrypted.length>4*1024*1024)throw new Error("Encrypted state exceeds record limit");
  let plain:Buffer|undefined;let lastError:unknown;
  for(const [value,label] of [[env.stateEncryptionKey,"STATE_ENCRYPTION_KEY"],[env.previousStateEncryptionKey,"PREVIOUS_STATE_ENCRYPTION_KEY"]] as const){if(!value)continue;try{const decipher=createDecipheriv("aes-256-gcm",encryptionKey(value,label),Buffer.from(record.nonce,"base64url"));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(record.tag,"base64url"));plain=Buffer.concat([decipher.update(encrypted),decipher.final()]);break}catch(e){lastError=e}}
  if(!plain)throw lastError instanceof Error?lastError:new Error("No configured key can decrypt this state");const decoded=record.v===2?gunzipSync(plain,{maxOutputLength:8*1024*1024}):plain;if(decoded.length>8*1024*1024)throw new Error("Decrypted state exceeds plaintext limit");return JSON.parse(decoded.toString("utf8")) as T;
}

export function signValue(value: string) {
  return createHmac("sha256", secretBytes(env.adminSessionSecret, "ADMIN_SESSION_SECRET")).update(value).digest("base64url");
}

export function verifySignature(value: string, signature: string) {
  try { return safeCompare(signValue(value), signature); } catch { return false; }
}
