import { NextRequest } from "next/server";
import { fetchPanelExport } from "@/lib/remote";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source")?.toUpperCase();
  const id = request.nextUrl.searchParams.get("id");
  const version = request.nextUrl.searchParams.get("version");
  if (source !== "UK" && source !== "AU") {
    return Response.json({ error: "source must be UK or AU" }, { status: 400 });
  }
  if (!id || !/^\d{1,8}$/.test(id) || Number(id) < 1) {
    return Response.json({ error: "id must be a positive PanelApp panel id" }, { status: 400 });
  }
  if (!version || !/^\d+(?:\.\d+)?$/.test(version)) {
    return Response.json({ error: "version must match the catalogue panel version" }, { status: 400 });
  }
  try {
    const text = await fetchPanelExport(source, id, version, { signal: request.signal });
    return new Response(text, {
      headers: {
        "Content-Type": "text/tab-separated-values; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
        "X-PanelApp-Source": source,
        "X-PanelApp-Version": version,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not retrieve the panel export" },
      { status: 502 },
    );
  }
}
