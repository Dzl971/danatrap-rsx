# Changements V4 — Render

- remplacement du Cloudflare Worker par une API Node.js adaptée à Render ;
- API sans dépendance externe, plus simple à déployer et à maintenir ;
- ajout du Blueprint `render.yaml` créant automatiquement le Static Site et le Web Service ;
- génération automatique de `frontend/config.js` pendant le build Render ;
- liaison automatique de l’adresse publique de l’API au frontend ;
- variables secrètes protégées dans le tableau de bord Render ;
- health check `/health` ;
- réveil discret de l’API au chargement du site ;
- upload Google Drive resumable en morceaux de 8 Mo ;
- diffusion audio avec prise en charge de l’en-tête Range ;
- liens média signés avec HMAC et expiration ;
- limitation de débit pour les routes sensibles ;
- vérification renforcée des sessions Google Drive ;
- suppression impossible de son propre compte administrateur ;
- cache PWA V4 avec `config.js` récupéré en priorité sur le réseau ;
- comptes de démonstration masqués automatiquement en mode réel ;
- en-têtes de sécurité Render pour le site statique et l’API.

## Compléments fonctionnels et sécurité

- reconstruction des pages qui manquaient dans la V3 : tableau de bord, catalogue, fiches de production, annuaires Beatmakers/Artistes, profils, réservations, messagerie, collaborations, upload, statistiques, réglages et administration ;
- réservation d’une licence avec notification automatique, création de conversation et bloc récapitulatif de la production ;
- validation d’une réservation puis passage possible de la production en **Expiré** ;
- annuaires complets Beatmakers et Artistes avec recherche ;
- personnalisation des profils et de chaque production, y compris couleurs, arrière-plans, cadres, polices et icônes Play/Pause ;
- récupération réelle des utilisateurs Supabase pour l’administration via `GET /admin/users` ;
- contrôle serveur des uploads : images de profil autorisées pour leur propriétaire, fichiers musicaux réservés aux Beatmakers/Producteurs, vérification de la propriété de la production et accès total pour l’Admin ;
- limite d’upload configurable avec `MAX_UPLOAD_BYTES` (5 Gio par défaut).
