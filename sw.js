const CORE_CACHE = "gcfr-core-v3";
const RELEASE_CACHE_PREFIX = "gcfr-release-";

const scopeUrl = new URL(self.registration.scope);

function atScope(path) {
  return new URL(path, scopeUrl).href;
}

const CORE_ASSETS = [
  atScope("./"),
  atScope("index.html"),
  atScope("release.json"),
  atScope("release-client.js"),
  atScope("manifest.webmanifest"),
  atScope("offline.html"),
  atScope("icons/icon-192.png"),
  atScope("icons/icon-512.png")
];

async function fetchReleaseState() {
  try {
    const response = await fetch(atScope(`release.json?ts=${Date.now()}`), {
      cache: "no-store"
    });

    if (response.ok) {
      const cache = await caches.open(CORE_CACHE);
      await cache.put(atScope("release.json"), response.clone());
      return await response.json();
    }
  } catch {}

  const cached = await caches.match(atScope("release.json"));
  return cached ? cached.json() : null;
}

async function cacheRelease(version) {
  if (!version) return;

  // A public version can receive same-version patches. Rebuild that release
  // cache so v2.2.7 does not stay pinned to the first v2.2.7 files forever.
  const cacheName = `${RELEASE_CACHE_PREFIX}${version}`;
  await caches.delete(cacheName);
  const cache = await caches.open(cacheName);
  const base = `releases/${version}/`;

  await cache.addAll([
    atScope(`${base}index.html`),
    atScope(`${base}app.js`),
    atScope(`${base}styles.css`),
    atScope(`${base}barcode-scanner.js`),
    atScope(`${base}stock.js`),
    atScope(`${base}stock.css`),
    atScope(`${base}vendor/zxing-reader.js`),
    atScope(`${base}vendor/zxing_reader.wasm`)
  ]);
}

async function warmReleaseSlots() {
  const state = await fetchReleaseState();
  if (!state) return;

  const versions = [state.current, state.previous, state.patching]
    .filter(Boolean);

  for (const version of versions) {
    try {
      await cacheRelease(version);
    } catch (error) {
      console.warn("Could not cache release", version, error);
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_ASSETS);
    await warmReleaseSlots();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();

    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith("gcfr-core-") && name !== CORE_CACHE)
        .map((name) => caches.delete(name))
    );

    await warmReleaseSlots();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CACHE_RELEASE" && event.data.version) {
    event.waitUntil(cacheRelease(event.data.version));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin) return;

  const relativePath = url.pathname.startsWith(scopeUrl.pathname)
    ? url.pathname.slice(scopeUrl.pathname.length)
    : "";

  if (relativePath.startsWith("release.json")) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        const cache = await caches.open(CORE_CACHE);
        await cache.put(atScope("release.json"), response.clone());
        return response;
      } catch {
        return (await caches.match(atScope("release.json")))
          || new Response("{}", {
            headers: { "Content-Type": "application/json" }
          });
      }
    })());
    return;
  }

  if (relativePath.startsWith("releases/")) {
    event.respondWith((async () => {
      try {
        // Same-version patches must reach the device. Prefer network for
        // release assets, then refresh the version cache; use cache offline.
        const response = await fetch(request, { cache: "no-store" });

        if (response.ok) {
          const parts = relativePath.split("/");
          const version = parts[1];
          const cache = await caches.open(`${RELEASE_CACHE_PREFIX}${version}`);
          await cache.put(request, response.clone());
        }

        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (request.mode === "navigate") {
          return (await caches.match(atScope("offline.html")))
            || new Response("Offline", { status: 503 });
        }

        throw new Error("Offline");
      }
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match(atScope("index.html")))
          || (await caches.match(atScope("offline.html")));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);

      if (response.ok) {
        const cache = await caches.open(CORE_CACHE);
        await cache.put(request, response.clone());
      }

      return response;
    } catch {
      return new Response("", { status: 503 });
    }
  })());
});
