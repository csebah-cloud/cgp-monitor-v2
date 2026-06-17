// CGP Monitor V2 — service worker AUTO-DESTRUCTEUR.
// On n'utilise PAS de service worker (il causait des problèmes de cache).
// Ce fichier existe uniquement pour neutraliser un éventuel SW résiduel :
// il vide tous les caches, se désinscrit, puis recharge les onglets ouverts.
// Il n'est volontairement PAS enregistré par la page (voir index.html / app.js).
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        } catch (e) {}
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
            try { client.navigate(client.url); } catch (e) {}
        }
    })());
});

// Pass-through : on ne sert jamais depuis le cache.
self.addEventListener('fetch', () => {});
