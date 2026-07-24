# DanaTrap RSX V4 — Version Render

DanaTrap RSX est une plateforme web musicale qui met en relation artistes et beatmakers autour d’un système de **réservation**, de messagerie et de personnalisation avancée.

## Architecture de cette version

- **Render Static Site** : interface publique, PWA et lecteur audio.
- **Render Web Service Node.js** : uploads sécurisés, Google Drive, médias signés et actions administrateur sensibles.
- **Supabase** : inscription, connexion, profils, productions, licences, réservations, messages, notifications et règles de sécurité.
- **Google Drive** : stockage des MP3, WAV, FLP, ZIP, stems, pochettes et fichiers privés.

Le fichier `render.yaml` crée automatiquement les deux services Render depuis le même dépôt GitHub.

## Test immédiat sans compte externe

Ouvre `frontend/index.html`. La configuration locale reste en mode démonstration.

Comptes de démonstration :

- Beatmaker : `demo@danatrap.fr` / `DEMO1234`
- Artiste : `artiste@danatrap.fr` / `ARTISTE1234`
- Administrateur : `admin@danatrap.fr` / `ADMIN1234`

Les changements de démonstration restent dans le navigateur avec `localStorage`.

## Mise en ligne réelle

Lis dans cet ordre :

1. `DEPLOIEMENT-RENDER-PAS-A-PAS.md`
2. `supabase/schema.sql`
3. `backend/render-api/.env.example`

## Fichiers importants

```text
DanaTrap-RSX-Render/
├── frontend/                     Site statique et PWA
├── backend/render-api/           API Node.js sans dépendance externe
├── supabase/schema.sql           Base, fonctions et règles RLS
├── tools/get-google-refresh-token.mjs
├── render.yaml                   Blueprint Render automatique
└── DEPLOIEMENT-RENDER-PAS-A-PAS.md
```

## Sécurité

Ne mets jamais dans GitHub ou `frontend/config.js` :

- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `FILE_SIGNING_SECRET`

Ces valeurs sont uniquement destinées aux variables d’environnement du Web Service Render.
