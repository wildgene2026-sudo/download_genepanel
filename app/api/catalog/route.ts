import { NextResponse } from "next/server";
import { EXPORT_HEADERS } from "@/lib/panelapp";
import { latestHpoRelease, listPanelAppPanels } from "@/lib/remote";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const [hpoResult, ukResult, auResult] = await Promise.allSettled([
    latestHpoRelease({ signal: request.signal }),
    listPanelAppPanels("UK", { signal: request.signal }),
    listPanelAppPanels("AU", { signal: request.signal }),
  ]);
  const message = (result: PromiseRejectedResult) =>
    result.reason instanceof Error ? result.reason.message : "Reference source unavailable";
  const errors = {
    ...(hpoResult.status === "rejected" ? { hpo: message(hpoResult) } : {}),
    ...(ukResult.status === "rejected" ? { UK: message(ukResult) } : {}),
    ...(auResult.status === "rejected" ? { AU: message(auResult) } : {}),
  };

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      hpo: hpoResult.status === "fulfilled" ? hpoResult.value : null,
      sources: {
        UK: ukResult.status === "fulfilled" ? ukResult.value : [],
        AU: auResult.status === "fulfilled" ? auResult.value : [],
      },
      errors,
      contract: {
        headers: EXPORT_HEADERS,
        greenLevels: ["3", "4"],
        entityTypes: ["gene", "str", "region"],
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
