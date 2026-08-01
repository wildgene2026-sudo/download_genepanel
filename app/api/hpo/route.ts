import { fetchVerifiedHpo } from "@/lib/remote";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { bytes, release } = await fetchVerifiedHpo({ signal: request.signal });
    return new Response(bytes, {
      headers: {
        "Content-Type": "text/obo; charset=utf-8",
        "Content-Disposition": 'attachment; filename="hp.obo"',
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
        "X-HPO-Release": release.tag,
        "X-HPO-SHA256": release.digest.slice("sha256:".length),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not download hp.obo" },
      { status: 502 },
    );
  }
}
