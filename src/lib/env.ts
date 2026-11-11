import { z } from "zod";

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
  baseUrl: process.env.FREE_ROUTER_BASE_URL,
  providers: [
    { id: "openrouter", label: "OpenRouter", envPrefix: "OPEN_ROUTER_API_KEY_", baseUrl: "https://openrouter.ai/api/v1", count: 9 },
    { id: "google", label: "Google AI Studio", envPrefix: "GEMINI_API_KEY_", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", count: 9 },
    { id: "nvidia", label: "NVIDIA NIM", envPrefix: "NVIDIA_NIM_API_KEY_", baseUrl: "https://integrate.api.nvidia.com/v1", count: 9 },
    { id: "matilda", label: "Matilda (Maincode)", envPrefix: "MATILDA_API_KEY_", baseUrl: "https://matilda.maincode.com/api/v1", count: 9 },
    { id: "zenmux", label: "ZenMux", envPrefix: "ZENMUX_API_KEY_", baseUrl: "https://zenmux.ai/api/v1", count: 9 },
    { id: "orcarouter", label: "OrcaRouter", envPrefix: "ORCAROUTER_API_KEY_", baseUrl: "https://api.orcarouter.ai/v1", count: 9 },
    { id: "mistral", label: "Mistral", envPrefix: "MISTRAL_API_KEY_", baseUrl: "https://api.mistral.ai/v1", count: 9 },
    { id: "tokenharbor", label: "TokenHarbor", envPrefix: "TOKENHARBOR_API_KEY_", baseUrl: "https://tokenharbor.ai/v1", count: 9 },
    { id: "groq", label: "Groq", envPrefix: "GROQ_API_KEY_", baseUrl: "https://api.groq.com/openai/v1", count: 9 },
    { id: "novita", label: "Novita AI", envPrefix: "NOVITA_API_KEY_", baseUrl: "https://api.novita.ai/openai/v1", count: 9 },
    { id: "hyperbolic", label: "Hyperbolic", envPrefix: "HYPERBOLIC_API_KEY_", baseUrl: "https://api.hyperbolic.ai/inference/v1", count: 9 },
    { id: "inference", label: "Inference.net", envPrefix: "INFERENCE_API_KEY_", baseUrl: "https://api.inference.net/v1", count: 9 },
    { id: "azure", label: "Azure OpenAI", envPrefix: "AZURE_OPENAI_API_KEY_", baseUrl: "https://{resource}.openai.azure.com", count: 9 },
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

export function getConfigurationStatus() {
  return {
    mongo: Boolean(env.mongoUri), redis: Boolean(env.redisUrl && env.redisToken),
    smtp: Boolean(env.smtpHost && env.smtpPort && env.smtpUser && env.smtpPassword), sessionSecret: Boolean(env.adminSessionSecret),
    encryptionKey: Boolean(env.stateEncryptionKey), clientKeyHashSecret: Boolean(env.clientKeyHashSecret),
    jev: Boolean(env.jevKey),
    baseUrl: Boolean(env.baseUrl),
    providers: env.providers.map((p) => ({ id: p.id, label: p.label, slots: Array.from({ length: p.count }, (_, i) => ({ slot: i + 1, configured: false })) })),
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
  FREE_ROUTER_BASE_URL: optional,
});
