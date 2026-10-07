const CACHE_NAME = "myroom-shell-v3-3-4";

self.addEventListener("push", (event) => {
  let payload = {
    title: "kurashio",
    body: "センサーに関する通知があります",
    tag: "myroom-sensor",
    url: "/",
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = { ...payload, ...parsed };
      }
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/kurashio-icon-192.png",
      badge: "/kurashio-icon-192.png",
      data: { url: payload.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // 新しいビルドの有無を確かめるための値。**キャッシュに載せてはいけない**（#277）。
  // 一度でも載せると古いバージョンを返し続け、アプリは永久に更新へ気付けなくなる
  if (url.pathname === "/version.json") return;
  // Next.js の JS/CSS チャンクは常にネットワーク優先（古いバンドル参照を防ぐ）。
  // **通信できなかったときだけ**控えから返す（#736）。控えのHTMLだけ返してもチャンクが無いと
  // 画面が組み上がらないため。404（デプロイ直後にチャンクが未着・#450）は失敗ではないので
  // そのまま返し、控えには成功した応答だけを残す。控えは CACHE_NAME（版ごと）と一緒に消える
  if (url.pathname.startsWith("/_next/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw new TypeError("offline and not cached");
        })
    );
    return;
  }

  if (request.mode === "navigate") {
    // オフラインのときに出す控え。**成功した応答だけを、そのページのURLで残す**（#450）。
    // 以前はどのページでも "/" へ上書きし、再起動中の 502/503 まで残していたため、
    // 控えから出るのが別のページのHTMLやエラーページになることがあった
    const cacheKey = url.pathname;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
          }
          return response;
        })
        .catch(
          async () =>
            (await caches.match(cacheKey)) ??
            (await caches.match("/")) ??
            (await caches.match("/index.html"))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (!response.ok) return response;

          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => cached);
    })
  );
});
