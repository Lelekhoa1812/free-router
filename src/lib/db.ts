import { MongoClient, type Db } from "mongodb";
import { env } from "@/lib/env";

declare global { var _freeRouterMongo: Promise<MongoClient> | undefined; var _freeRouterIndexes: Promise<void> | undefined; }

async function connectDb(): Promise<Db> {
  if (!env.mongoUri) throw new Error("MongoDB is not configured");
  globalThis._freeRouterMongo ??= new MongoClient(env.mongoUri, {
    maxPoolSize: 3, minPoolSize: 0, maxConnecting: 1,
    serverSelectionTimeoutMS: 4000, connectTimeoutMS: 4000, socketTimeoutMS: 8000,
    retryWrites: true, appName: "FreeRouter",
  }).connect();
  const client = await globalThis._freeRouterMongo;
  return client.db(env.mongoDb);
}

export async function ensureIndexes() {
  globalThis._freeRouterIndexes ??= (async () => {
    const db = await connectDb();
    await Promise.all([
      db.collection("client_keys").createIndex({ tokenHash: 1 }, { unique: true, name: "token_hash" }),
      db.collection("credential_health").createIndex({ provider: 1, fingerprint: 1 }, { unique: true, name: "credential_health_key" }),
      db.collection("credential_health").createIndex({ cooldownUntil: 1 }, { name: "credential_health_cooldown" }),
      db.collection("model_bindings").createIndex({ provider:1,model:1,fingerprint:1 },{unique:true,name:"model_binding_key"}),
      db.collection("model_overload_breakers").createIndex({ provider:1,model:1 },{unique:true,name:"model_overload_breaker_key"}),
      db.collection("model_overload_breakers").createIndex({ expiresAt:1 },{expireAfterSeconds:0,name:"model_overload_breaker_ttl"}),
      db.collection("responses").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "response_ttl" }),
      db.collection("responses").createIndex({ responseId: 1 }, { unique: true, name: "response_id" }),
      db.collection("responses").createIndex({ ownerId: 1, createdAt: -1 }, { name: "response_owner_time" }),
      db.collection("requests").createIndex({ createdAt: -1 }, { name: "requests_time" }),
      db.collection("requests").createIndex({ requestId: 1 }, { unique: true, name: "request_id" }),
      db.collection("requests").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "requests_ttl" }),
      db.collection("metrics").createIndex({ bucketAt: 1 }, { name: "metrics_bucket" }),
      db.collection("metrics").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "metrics_ttl" }),
      db.collection("debug_payloads").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "debug_ttl" }),
      db.collection("tool_metadata").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "tool_ttl" }),
      db.collection("tool_metadata").createIndex({ ownerId: 1, callId: 1 }, { name: "tool_owner_call" }),
      db.collection("audit_events").createIndex({ createdAt: -1 }, { name: "audit_time" }),
      db.collection("audit_events").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "audit_ttl" }),
      db.collection("probe_results").createIndex({ createdAt: -1 }, { name: "probe_time" }),
      db.collection("probe_results").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "probe_ttl" }),
    ]);
  })();
  return globalThis._freeRouterIndexes;
}
export async function getDb(): Promise<Db> { const db=await connectDb(); await ensureIndexes(); return db; }
