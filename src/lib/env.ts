import { z } from "zod";
import { createHash } from "node:crypto";

const optional = z.string().optional();
export const env = {
  mongoUri: process.env.MONGO_DB_CONNECTION_STRING,
  mongoDb: process.env.MONGODB_DB || "freerouter",
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET,
  stateEncryptionKey: process.env.STATE_ENCRYPTION_KEY,
  previousStateEncryptionKey: process.env.PREVIOUS_STATE_ENCRYPTION_KEY,
  clientKeyHashSecret: process.env.CLIENT_KEY_HASH_SECRET,
  cronSecret: process.env.CRON_SECRET,
  providers: [
    { id: "openrouter", label: "OpenRouter", envPrefix: "OPEN_ROUTER_API_KEY_", baseUrl: "https://openrouter.ai/api/v1", count: 9 },
    { id: "google", label: "Google AI Studio", envPrefix: "GEMINI_API_KEY_", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", count: 9 },
    { id: "nvidia", label: "NVIDIA NIM", envPrefix: "NVIDIA_NIM_API_KEY_", baseUrl: "https://integrate.api.nvidia.com/v1", count: 9 },
    { id: "matilda", label: "Matilda (Maincode)", envPrefix: "MATILDA_API_KEY_", baseUrl: "https://matilda.maincode.com/api/v1", count: 9 },
  ] as const,
  jevKey: process.env.JEV_TYPESAFE_API_KEY,
  smtpHost: process.env.SMTP_HOST,
  smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,
  imapHost: process.env.IMAP_HOST,
  imapPort: process.env.IMAP_PORT ? Number(process.env.IMAP_PORT) : undefined,
};
export const providers = env.providers;

export function getProviderCredentials() {
  return env.providers.flatMap((provider) => Array.from({ length: provider.count }, (_, i) => {
    const slot = i + 1;
    const secret = process.env[`${provider.envPrefix}${slot}`]?.trim();
    return secret ? { provider: provider.id, label: provider.label, slot, secret, fingerprint:createHash("sha256").update(secret).digest("hex") } : null;
  }).filter((v): v is NonNullable<typeof v> => v !== null));
}

export function getConfigurationStatus() {
  return {
    mongo: Boolean(env.mongoUri), redis: Boolean(env.redisUrl && env.redisToken),
    smtp: Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPassword), sessionSecret: Boolean(env.adminSessionSecret),
    encryptionKey: Boolean(env.stateEncryptionKey), clientKeyHashSecret: Boolean(env.clientKeyHashSecret),
    jev: Boolean(env.jevKey),
    providers: env.providers.map((p) => ({ id: p.id, label: p.label, slots: Array.from({ length: p.count }, (_, i) => ({ slot: i + 1, configured: Boolean(process.env[`${p.envPrefix}${i + 1}`]?.trim()) })) })),
  };
}

export const requiredEnvironmentSchema = z.object({
  MONGO_DB_CONNECTION_STRING: optional,
  UPSTASH_REDIS_REST_URL: optional,
  UPSTASH_REDIS_REST_TOKEN: optional,
  SMTP_HOST: optional,
  SMTP_PORT: optional,
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  IMAP_HOST: optional,
  IMAP_PORT: optional,
  ADMIN_SESSION_SECRET: optional,
  STATE_ENCRYPTION_KEY: optional,
  CLIENT_KEY_HASH_SECRET: optional,
  CRON_SECRET: optional,
});
