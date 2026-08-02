import assert from "node:assert/strict";
import test from "node:test";
import { fetchVerifiedHpo, listPanelAppPanels } from "../lib/remote.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("requires the complete PanelApp count across pagination", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const page = new URL(String(url)).searchParams.get("page");
      return page === "2"
        ? jsonResponse({ count: 2, next: null, results: [{ id: 2, name: "Beta", version: 1.2, status: "public", stats: {} }] })
        : jsonResponse({
            count: 2,
            next: "https://panelapp.genomicsengland.co.uk/api/v1/panels/?format=json&page=2",
            results: [{ id: 1, name: "Alpha", version: 1.1, status: "public", stats: {} }],
          });
    };
    const panels = await listPanelAppPanels("UK", { minimumIntervalMs: 0 });
    assert.deepEqual(panels.map((panel) => panel.id), [1, 2]);

    globalThis.fetch = async () => jsonResponse({
      count: 2,
      next: null,
      results: [{ id: 1, name: "Alpha", version: 1.1, status: "public", stats: {} }],
    });
    await assert.rejects(() => listPanelAppPanels("UK", { minimumIntervalMs: 0 }), /incomplete/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("backs off after a rate-limit response before retrying", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "0.001" } })
        : jsonResponse({ count: 1, next: null, results: [{ id: 1, name: "Alpha", version: 1.1, status: "public", stats: {} }] });
    };
    const panels = await listPanelAppPanels("UK", { minimumIntervalMs: 0 });
    assert.equal(attempts, 2);
    assert.equal(panels.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serializes simultaneous PanelApp requests from the same runtime", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximumActive = 0;
  try {
    globalThis.fetch = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return jsonResponse({ count: 1, next: null, results: [{ id: 1, name: "Alpha", version: 1.1, status: "public", stats: {} }] });
    };
    await Promise.all([
      listPanelAppPanels("UK", { minimumIntervalMs: 5 }),
      listPanelAppPanels("UK", { minimumIntervalMs: 5 }),
    ]);
    assert.equal(maximumActive, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops instead of retrying before a long server-requested cooldown", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "600" } });
    };
    await assert.rejects(
      () => listPanelAppPanels("UK", { minimumIntervalMs: 5 }),
      /cooldown longer than five minutes/i,
    );
    await assert.rejects(
      () => listPanelAppPanels("UK", { minimumIntervalMs: 5 }),
      /cooldown is active/i,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloads the official hp.obo bytes only after digest and structure verification", async () => {
  const originalFetch = globalThis.fetch;
  const text = `format-version: 1.2\nontology: hp\n\n[Term]\nid: HP:0000001\nname: All\n${"!".repeat(1_000_000)}`;
  const bytes = new TextEncoder().encode(text);
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = `sha256:${Array.from(digestBytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  try {
    globalThis.fetch = async (url) => String(url).includes("api.github.com")
      ? jsonResponse({
          tag_name: "v-test",
          published_at: "2026-08-02T00:00:00Z",
          assets: [{ name: "hp.obo", browser_download_url: "https://example.test/hp.obo", size: bytes.length, digest }],
        })
      : new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });

    const result = await fetchVerifiedHpo();
    assert.equal(result.release.tag, "v-test");
    assert.deepEqual(result.bytes, bytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
