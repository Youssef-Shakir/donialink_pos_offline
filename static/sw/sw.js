/*
 * DoniaLink POS offline service worker (scope /pos/).
 *
 * Keeps the POS page (/pos/ui) and the files it uses (JS/CSS bundles, translations, fonts,
 * images) so the POS opens when the server can't be reached. JSON-RPC calls are never
 * cached here: the POS data (load_data) is kept by the page itself (offline_data.js).
 *
 *   /pos/ui             network first, saved copy when offline (one per POS config)
 *   /web/assets/<hash>  saved copy first (the hash changes when the file changes)
 *   other files         saved copy first, refreshed in the background
 */
"use strict";

const PAGES = "dl-pos-pages-v1";
const FILES = "dl-pos-files-v1";
const PAGE_TIMEOUT = 10000; // slow network: show the saved page after 10 s

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((n) => n.startsWith("dl-pos-") && n !== PAGES && n !== FILES)
                        .map((n) => caches.delete(n))
                )
            )
            .then(() => self.clients.claim())
    );
});

function isPosPage(url) {
    return url.origin === self.location.origin && (url.pathname === "/pos/ui" || url.pathname === "/pos/web");
}

/** One saved page per POS config, whatever other parameters the URL has. */
function pageKey(url) {
    return self.location.origin + "/pos/ui?config_id=" + (url.searchParams.get("config_id") || "");
}

function isFile(url) {
    if (url.origin !== self.location.origin) {
        return false;
    }
    const p = url.pathname;
    return (
        p.startsWith("/web/assets/") ||
        p.includes("/static/") ||
        p.startsWith("/web/webclient/translations/") ||
        p.startsWith("/web/image") ||
        p.startsWith("/web/binary/company_logo")
    );
}

/** /web/assets/<hash>/<bundle> -> [hash, bundle]; null for debug assets (no hash). */
function assetParts(url) {
    const m = url.pathname.match(/^\/web\/assets\/([^/]+)\/(.+)$/);
    return m && m[1] !== "debug" ? [m[1], m[2]] : null;
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET" || req.headers.has("range")) {
        return; // RPC calls, uploads, audio/video ranges: straight to the network
    }
    const url = new URL(req.url);
    if (req.mode === "navigate" && isPosPage(url)) {
        event.respondWith(page(req, url));
    } else if (isFile(url)) {
        event.respondWith(assetParts(url) ? cacheFirst(req, url) : staleWhileRevalidate(event, req, url));
    }
});

async function page(req, url) {
    const cache = await caches.open(PAGES);
    const network = fetch(req).then(async (res) => {
        // Only a real POS page: not a redirect to the login page or the back office.
        if (res.ok && !res.redirected && res.type === "basic") {
            await cache.put(pageKey(url), res.clone());
        }
        return res;
    });
    network.catch(() => {}); // still running after we answered with the saved page
    try {
        return await withTimeout(network, PAGE_TIMEOUT);
    } catch (e) {
        const saved = await cache.match(pageKey(url));
        if (saved) {
            return saved;
        }
        return network; // nothing saved yet: wait for the network (or show its error)
    }
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), ms);
        promise.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); }
        );
    });
}

async function cacheFirst(req, url) {
    const cache = await caches.open(FILES);
    const saved = await cache.match(req);
    if (saved) {
        return saved;
    }
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
        await cache.put(req, res.clone());
        pruneOldBundles(cache, url);
    }
    return res;
}

async function staleWhileRevalidate(event, req, url) {
    const cache = await caches.open(FILES);
    const saved = await cache.match(req);
    const network = fetch(req).then(async (res) => {
        if (res.ok && res.type === "basic") {
            await cache.put(req, res.clone());
        }
        return res;
    });
    if (saved) {
        event.waitUntil(network.catch(() => {}));
        return saved;
    }
    return network;
}

/** A new version of a bundle replaces the old one (same name, other hash). */
async function pruneOldBundles(cache, url) {
    const [hash, name] = assetParts(url);
    for (const key of await cache.keys()) {
        const parts = assetParts(new URL(key.url));
        if (parts && parts[1] === name && parts[0] !== hash) {
            await cache.delete(key);
        }
    }
}

/**
 * The page asks us to save what it loaded before this worker was in control (first start):
 * {type: "warm", page: location.href, files: [urls]}.
 */
self.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "warm") {
        event.waitUntil(warm(msg));
    }
});

async function warm(msg) {
    const files = await caches.open(FILES);
    for (const u of msg.files || []) {
        try {
            const url = new URL(u, self.location.origin);
            if (!isFile(url) || (await files.match(url.href))) {
                continue;
            }
            const res = await fetch(url.href, { credentials: "same-origin" });
            if (res.ok && res.type === "basic") {
                await files.put(url.href, res);
            }
        } catch (e) {
            // offline or gone: skip it
        }
    }
    if (msg.page) {
        const url = new URL(msg.page);
        const pages = await caches.open(PAGES);
        if (isPosPage(url) && !(await pages.match(pageKey(url)))) {
            try {
                const res = await fetch(url.href, { credentials: "same-origin" });
                if (res.ok && !res.redirected) {
                    await pages.put(pageKey(url), res);
                }
            } catch (e) {
                // try again next start
            }
        }
    }
}
