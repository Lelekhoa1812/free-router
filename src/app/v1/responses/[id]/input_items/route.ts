import { GET as getResponse } from "@/app/v1/responses/[id]/route";
const noStore = { "cache-control": "no-store" };

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const response = await getResponse(request, ctx);
  if (!response || !response.ok) return response || Response.json({ error: "response_unavailable" }, { status: 404, headers: noStore });
  const d = await response.json();
  const raw = d.input || [];
  const items = typeof raw === "string" ? [{ role: "user", content: raw }] : raw;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 20)));
  const after = url.searchParams.get("after");
  const start = after ? Math.max(0, Number(after.replace(/^item_/, "")) + 1) : 0;
  const page = items.slice(start, start + limit);
  return Response.json({ object: "list", data: page.map((item: any, index: number) => ({ id: `item_${start + index}`, type: item.type || "message", ...item })), has_more: start + limit < items.length, first_id: page.length ? `item_${start}` : null, last_id: page.length ? `item_${start + page.length - 1}` : null }, { headers: noStore });
}
