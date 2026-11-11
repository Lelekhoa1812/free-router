import { env } from "@/lib/env";

export async function GET() {
  return Response.json(
    {
      baseUrl: env.baseUrl || "",
    },
    {
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=600",
      },
    }
  );
}