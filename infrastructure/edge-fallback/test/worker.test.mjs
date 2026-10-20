import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { origins, request } from "./helpers.mjs";

const fallback = (response) => response.headers.get("X-KHE-Fallback") === "1";

describe("origin answers", () => {
  for (const status of [200, 301, 404]) {
    test(`${status} passes through unchanged`, async () => {
      const { response, body } = await request("khe", "/architecture/", {
        origin: origins.status(status, { Location: "/elsewhere/" }),
      });
      assert.equal(response.status, status);
      assert.equal(body, `origin ${status}`);
      assert.equal(response.headers.get("Location"), "/elsewhere/");
      assert.ok(!fallback(response));
    });
  }

  test("the origin is fetched once, without following redirects", async () => {
    const { seen } = await request("khe", "/", { origin: origins.status(200) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.redirect, "manual");
  });
});

describe("origin fails", () => {
  const cases = {
    502: origins.status(502),
    530: origins.status(530),
    "a thrown fetch": origins.throws(),
    "a timeout": origins.hangs(),
  };
  for (const [name, origin] of Object.entries(cases)) {
    test(`${name} falls back to the copy`, async () => {
      const { response, body } = await request("khe", "/", { origin });
      assert.equal(response.status, 200);
      assert.match(body, /khe landing/);
      assert.ok(fallback(response));
    });
  }
});

describe("never falls back", () => {
  test("POST gets the origin's 530", async () => {
    const { response } = await request("games", "/study/", { method: "POST" });
    assert.equal(response.status, 530);
    assert.ok(!fallback(response));
  });

  test("/adventure/api/generate gets the origin's 502", async () => {
    const { response } = await request("games", "/adventure/api/generate", { origin: origins.status(502) });
    assert.equal(response.status, 502);
    assert.ok(!fallback(response));
  });

  test("khe.ee /healthz gets the origin's 530", async () => {
    const { response } = await request("khe", "/healthz");
    assert.equal(response.status, 530);
    assert.ok(!fallback(response));
  });
});

describe("SPA fallbacks", () => {
  const cases = [
    ["games", "/study/x", /<title>study</],
    ["khe", "/trips/x", /trips demo/],
    ["games", "/adventure/x", /<title>adventure</],
    ["games", "/x", /games hub/],
    ["games", "/adventure", /games hub/],
    ["games", "/study", /games hub/],
    ["khe", "/x", /khe landing/],
    ["khe", "/", /khe landing/],
    ["khe", "/architecture/", /khe architecture/],
    ["khe", "/r/abc123/", /share abc123/],
    ["games", "/", /games hub/],
  ];
  for (const [site, path, content] of cases) {
    test(`${site} ${path} serves its index`, async () => {
      const { response, body } = await request(site, path);
      assert.equal(response.status, 200);
      assert.match(body, content);
    });
  }

  test("HEAD is served from the copy too", async () => {
    const { response } = await request("khe", "/", { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.ok(fallback(response));
  });

  test("a hashed asset is served as itself", async () => {
    const { response, body } = await request("games", "/study/assets/study-6a7b8c.js");
    assert.equal(response.status, 200);
    assert.match(body, /study/);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  });

  test("the adventure config is the stub without a secret", async () => {
    const { response, body } = await request("games", "/adventure/config.js");
    assert.equal(response.status, 200);
    assert.match(body, /"apiSecret": ""/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
});

describe("hard 404s", () => {
  const cases = [
    "/r/unknown/",
    "/r/",
    "/r",
    "/reports",
    "/reports/",
    "/architecture/decisions/999/",
    "/r/abc123/assets/missing.js",
    "/trips/assets/missing.js",
    "/assets/missing.js",
  ];
  for (const path of cases) {
    test(`khe ${path} is 404`, async () => {
      const { response } = await request("khe", path);
      assert.equal(response.status, 404);
      assert.ok(fallback(response));
    });
  }

  test("games /study/assets/ miss is 404 and not cached for a year", async () => {
    const { response } = await request("games", "/study/assets/missing.js");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), "public, immutable");
  });

  test("a landing asset miss carries no long cache", async () => {
    const { response } = await request("khe", "/assets/missing.js");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Cache-Control"), null);
  });

  test("a landing asset hit is cached 30 days", async () => {
    const { response } = await request("khe", "/assets/site-a1b2c3.js");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=2592000");
  });

  test("a known ADR id is served", async () => {
    const { response, body } = await request("khe", "/architecture/decisions/001/");
    assert.equal(response.status, 200);
    assert.match(body, /adr 001/);
  });
});

describe("redirects", () => {
  const cases = [
    ["khe", "/lab?lang=et", "/architecture/?lang=et"],
    ["khe", "/lab/atlas?lang=et", "/architecture/?lang=et"],
    ["khe", "/house3d", "/ha/"],
    ["khe", "/house3d/a?b=1", "/ha/a?b=1"],
    ["khe", "/architecture/decisions/", "/architecture/#decisions"],
    ["khe", "/trips", "/trips/"],
    ["khe", "/trips?x=1", "/trips/?x=1"],
    ["khe", "/architecture", "/architecture/"],
    ["khe", "/ha", "/ha/"],
    ["khe", "/privacy?a=b", "/privacy/?a=b"],
    ["khe", "/r/abc123", "/r/abc123/"],
    ["khe", "/architecture/decisions/001", "/architecture/decisions/001/"],
  ];
  for (const [site, path, location] of cases) {
    test(`${site} ${path} is a 301 to ${location}`, async () => {
      const { response } = await request(site, path);
      assert.equal(response.status, 301);
      assert.equal(response.headers.get("Location"), location);
      assert.ok(fallback(response));
    });
  }
});

describe("slashes", () => {
  for (const path of ["//evil.com", "/\\evil.com", "//evil.com/"]) {
    test(`${path} never redirects off-site`, async () => {
      const { response } = await request("khe", path);
      const location = response.headers.get("Location");
      assert.ok(location === null || (location.startsWith("/") && !location.startsWith("//")), location);
    });
  }

  test("//architecture redirects like /architecture", async () => {
    const { response } = await request("khe", "//architecture");
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("Location"), "/architecture/");
  });
});

describe("headers", () => {
  for (const path of ["/r/abc123/", "/r/unknown/", "/trips/", "/trips/x"]) {
    test(`khe ${path} is noindex and private`, async () => {
      const { response } = await request("khe", path);
      assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
      assert.match(response.headers.get("Cache-Control"), /^private/);
    });
  }

  test("a share asset is cached a week, a miss is not", async () => {
    const hit = await request("khe", "/r/abc123/assets/share-d4e5f6.js");
    assert.equal(hit.response.headers.get("Cache-Control"), "private, max-age=604800, immutable");
    const miss = await request("khe", "/r/abc123/assets/missing.js");
    assert.equal(miss.response.headers.get("Cache-Control"), "private, no-cache");
  });

  test("games HSTS includes subdomains, khe.ee's does not", async () => {
    const games = await request("games", "/");
    assert.equal(games.response.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
    const khe = await request("khe", "/");
    assert.equal(khe.response.headers.get("Strict-Transport-Security"), "max-age=31536000");
  });

  test("/r/ carries no HSTS, as in nginx", async () => {
    const { response } = await request("khe", "/r/abc123/");
    assert.equal(response.headers.get("Strict-Transport-Security"), null);
  });

  test("the landing carries its CSP", async () => {
    const { response } = await request("khe", "/");
    assert.match(response.headers.get("Content-Security-Policy"), /^default-src 'self'/);
  });
});
