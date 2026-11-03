import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

export async function GET() {
  if (!await getAdminSession()) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  try {
    const db = await getDb();
    const [stats, existingCollections, redis] = await Promise.all([
      db.command({ dbStats: 1 }),
      db.listCollections({}, { nameOnly: true }).toArray(),
      (async () => {
        try {
          const client = getRedis();
          const [pingMs, keyCount] = await Promise.all([
            (async () => { const startedAt = performance.now(); await client.ping(); return Math.round(performance.now() - startedAt); })(),
            client.dbsize(),
          ]);
          return { status: "available" as const, keyCount: Number(keyCount), pingMs };
        } catch {
          return { status: "unavailable" as const, keyCount: null, pingMs: null };
        }
      })(),
    ]);
    let collectionStatsComplete = true;

    const collectionResults = await Promise.all(existingCollections.map(async ({ name }) => {
      try {
        const result = await db.command({ collStats: name });
        return {
          name,
          count: Number(result.count) || 0,
          sizeBytes: Number(result.size) || 0,
          indexBytes: Number(result.totalIndexSize) || 0,
        };
      } catch {
        collectionStatsComplete = false;
        return null;
      }
    }));

    return Response.json({
      database: db.databaseName,
      dataBytes: Number(stats.dataSize) || 0,
      indexBytes: Number(stats.indexSize) || 0,
      collections: collectionResults.filter((item): item is NonNullable<typeof item> => item !== null),
      collectionStatsComplete,
      coordination: { ...redis, sampledAt: new Date().toISOString() },
      observedAt: new Date().toISOString(),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "storage_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
