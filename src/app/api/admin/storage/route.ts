import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  if (!await getAdminSession()) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  try {
    const db = await getDb();
    const stats = await db.command({ dbStats: 1 });
    const existingCollections = await db.listCollections({}, { nameOnly: true }).toArray();
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
      observedAt: new Date().toISOString(),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "storage_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
