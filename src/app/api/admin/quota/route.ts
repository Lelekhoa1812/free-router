import { getAdminSession } from "@/lib/auth/admin";
import { getQuotaDashboard } from "@/lib/quota/dashboard";

export const runtime = "nodejs";

export async function GET() {
  if (!await getAdminSession()) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await getQuotaDashboard(), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json(
      {
        available: false,
        mode: "observe",
        generatedAt: new Date().toISOString(),
        warnings: ["quota_dashboard_unavailable"],
        providers: [],
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
