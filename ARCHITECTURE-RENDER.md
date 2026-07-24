# Architecture Render de DanaTrap RSX

```text
Visiteur
   │
   ▼
Render Static Site
(interface, PWA, transitions, lecteur)
   │
   ├──────────────► Supabase
   │                comptes, profils, beats, licences,
   │                réservations, messages, notifications
   │
   ▼
Render Web Service Node.js
(authentification du token Supabase,
Google OAuth, upload découpé, médias signés,
administration sensible)
   │
   ▼
Google Drive 2 To
Previews / Images / Fichiers privés
```

## Pourquoi deux services Render ?

Le Static Site reste rapide et disponible sur le CDN Render. Le Web Service gratuit peut redémarrer après une période d’inactivité, mais cela ne bloque pas l’affichage général du site. Le frontend effectue un appel discret à `/health` lors de l’ouverture afin de réveiller l’API avant un éventuel upload.

## Routes de l’API

- `GET /health` : état du serveur et vérification de configuration.
- `POST /upload-session` : démarre une session resumable Google Drive.
- `PUT /upload-chunk` : envoie un morceau de 8 Mo.
- `GET /media/:fileId` : diffuse une préécoute ou une image avec signature et expiration.
- `POST /admin/create-user` : création d’un utilisateur par l’administrateur.
- `POST /admin/delete-user` : suppression d’un utilisateur par l’administrateur.

Toutes les routes sensibles vérifient le jeton Supabase. Les fichiers sources ne sont jamais rendus publics directement.
