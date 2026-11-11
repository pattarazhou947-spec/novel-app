'use strict';
/*
 * Novel Creator Studio Pro — Service Worker (App Shell เท่านั้น)
 *
 * วางไฟล์นี้ไว้ "โฟลเดอร์เดียวกับไฟล์ HTML ของแอป" (เช่น novel_creator_studio_pro.html หรือ index.html)
 * ตัวแอปจะลงทะเบียนไฟล์นี้เองพร้อมบอกชื่อไฟล์ HTML ผ่าน query (?app=ชื่อไฟล์)
 *
 * หลักความปลอดภัยของข้อมูล:
 *  - Service Worker เข้าถึง localStorage ไม่ได้ และไฟล์นี้ไม่แตะข้อมูลนิยายใดๆ
 *  - ดักเฉพาะ "การเปิดหน้าแอป" (GET + navigate) เท่านั้น คำขออื่นทั้งหมดผ่านตรงไปที่เครือข่าย
 *    (ไฟล์สำรอง JSON, Import/Export, ดาวน์โหลด, POST ฯลฯ ไม่ถูกดักหรือแคช)
 *  - Stale-while-revalidate: เปิดจากแคชทันที แล้วโหลดเวอร์ชันใหม่เก็บไว้ใช้ครั้งถัดไป
 *    ไม่รีโหลดหน้าอัตโนมัติ ไม่เรียก skipWaiting() จึงไม่เปลี่ยนแอปกลางการเขียน
 *  - ไม่เก็บหน้าผิดปกติ (404, หน้าล็อกอิน Wi-Fi, ไม่ใช่ HTML ของแอป) ทับของเดิม
 *  - ลบเฉพาะแคชเก่าที่มี prefix ของแอปนี้ ไม่แตะแคชของแอปอื่นบนโดเมนเดียวกัน
 */
const SW_VERSION = '1.0.0';
const APP_MARKER = 'Novel Creator Studio Pro';
const SCOPE_URL = new URL(self.registration.scope);
const CACHE_PREFIX = 'novel-studio-shell:' + encodeURIComponent(SCOPE_URL.href) + ':';
const CACHE_NAME = CACHE_PREFIX + SW_VERSION;
const REVALIDATE_MIN_INTERVAL_MS = 60 * 1000;
let lastRevalidateAt = 0;

function resolveAppPage() {
  try {
    const requested = new URL(self.location.href).searchParams.get('app') || 'index.html';
    const url = new URL(requested, SCOPE_URL);
    // ต้องอยู่ origin และ scope เดียวกับ Service Worker เท่านั้น
    if (url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname)) {
      url.search = '';
      url.hash = '';
      return url;
    }
  } catch (error) { /* ใช้ค่าเริ่มต้นด้านล่าง */ }
  return new URL('index.html', SCOPE_URL);
}
const APP_PAGE = resolveAppPage();
// ถ้าแอปคือ index.html ให้รองรับการเปิดที่ "โฟลเดอร์" (…/) ด้วย
const SERVES_SCOPE_ROOT = APP_PAGE.pathname === SCOPE_URL.pathname + 'index.html';
const NAVIGATION_PATHS = [APP_PAGE.pathname].concat(SERVES_SCOPE_ROOT ? [SCOPE_URL.pathname] : []);

async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
// รับเฉพาะหน้าแอปจริง: 200 + HTML + มีชื่อแอป (กันเก็บหน้า 404 / captive portal / หน้าผิดไฟล์)
async function readValidAppPage(response) {
  if (!response || !response.ok || response.status !== 200) return null;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html')) return null;
  const text = await response.clone().text();
  if (!text.includes(APP_MARKER)) return null;
  return { text, response };
}
async function revalidate(cache, options = {}) {
  const now = Date.now();
  if (!options.force && now - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) return { changed: false, skipped: true };
  lastRevalidateAt = now;
  const fresh = await fetch(new Request(APP_PAGE.href, { cache: 'no-cache', credentials: 'same-origin' }));
  const valid = await readValidAppPage(fresh);
  if (!valid) return { changed: false, rejected: true };
  const cached = await cache.match(APP_PAGE.href, { ignoreSearch: true });
  let changed = true;
  if (cached) {
    const cachedText = await cached.clone().text();
    changed = (await digest(cachedText)) !== (await digest(valid.text));
  }
  if (changed) {
    await cache.put(APP_PAGE.href, valid.response.clone());
    if (SERVES_SCOPE_ROOT) await cache.put(SCOPE_URL.href, valid.response.clone());
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'APP_UPDATE_AVAILABLE', version: SW_VERSION }));
  }
  return { changed };
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // ต้องดาวน์โหลดหน้าแอปได้ครบและถูกต้อง ไม่เช่นนั้นการติดตั้งล้มเหลว และเวอร์ชันเก่ายังทำงานต่อ
    const response = await fetch(new Request(APP_PAGE.href, { cache: 'reload', credentials: 'same-origin' }));
    const valid = await readValidAppPage(response);
    if (!valid) throw new Error('App page is not available for offline cache');
    const cache = await caches.open(CACHE_NAME);
    await cache.put(APP_PAGE.href, valid.response.clone());
    if (SERVES_SCOPE_ROOT) await cache.put(SCOPE_URL.href, valid.response.clone());
    // ไม่เรียก skipWaiting(): เวอร์ชันเก่าทำงานต่อจนปิดทุกหน้าต่างของแอป
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin) return;
  // ดักเฉพาะ "การเปิดหน้าแอป" อย่างอื่นปล่อยผ่านไปที่เครือข่ายตามปกติ (JSON, ดาวน์โหลด, ไฟล์อื่น ฯลฯ)
  if (request.mode !== 'navigate' || !NAVIGATION_PATHS.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(APP_PAGE.href, { ignoreSearch: true });
    const update = revalidate(cache).catch(() => null); // ออฟไลน์/ล้มเหลว: ใช้ของเดิมต่อ ไม่ทับแคช
    if (cached) {
      event.waitUntil(update);
      return cached;
    }
    try {
      return await fetch(request);
    } catch (error) {
      const retry = await update;
      const fallback = await cache.match(APP_PAGE.href, { ignoreSearch: true });
      return fallback || new Response('ออฟไลน์ และยังไม่มีไฟล์แอปในแคช กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วเปิดใหม่', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

self.addEventListener('message', event => {
  const type = event.data && event.data.type;
  const port = event.ports && event.ports[0];
  if (type === 'CHECK_OFFLINE_READY') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const entry = await cache.match(APP_PAGE.href, { ignoreSearch: true });
        if (port) port.postMessage({ ready: Boolean(entry), version: SW_VERSION });
      } catch (error) {
        if (port) port.postMessage({ ready: false, version: SW_VERSION });
      }
    })());
  } else if (type === 'REVALIDATE') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const result = await revalidate(cache, { force: true });
        if (port) port.postMessage({ ok: !result.rejected, changed: Boolean(result.changed), rejected: Boolean(result.rejected), version: SW_VERSION });
      } catch (error) {
        if (port) port.postMessage({ ok: false, error: String((error && error.message) || error), version: SW_VERSION });
      }
    })());
  }
});
