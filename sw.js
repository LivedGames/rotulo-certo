// Rótulo Certo — service worker: deixa o app abrir sem internet.
// Ao publicar uma versão nova do app, aumente o número abaixo.
const VERSAO = "rotulo-certo-v1";
const ESSENCIAIS = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/favicon.png"];
const EXTERNOS = ["https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"];

self.addEventListener("install", ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(VERSAO);
    await c.addAll(ESSENCIAIS);
    for (const u of EXTERNOS) { try { await c.add(new Request(u, { mode: "no-cors" })); } catch (e) {} }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;                       // leitura de foto e IA: sempre direto ao servidor
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;
  if (/openfoodfacts\.org$/.test(url.hostname)) return;   // base de produtos: sempre on-line

  // página do app: tenta a rede (para pegar versão nova) e usa a cópia guardada se estiver sem internet
  if (req.mode === "navigate" || (url.origin === location.origin && url.pathname === "/")) {
    ev.respondWith((async () => {
      try {
        const r = await fetch(req);
        const c = await caches.open(VERSAO); c.put("/", r.clone());
        return r;
      } catch (e) {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // ícones, leitor de código de barras e fontes: usa a cópia e atualiza em segundo plano
  if (url.origin === location.origin || /unpkg\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    ev.respondWith((async () => {
      const c = await caches.open(VERSAO);
      const guardado = await c.match(req);
      const rede = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => null);
      return guardado || (await rede) || Response.error();
    })());
  }
});
