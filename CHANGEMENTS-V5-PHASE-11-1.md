# DanaTrap RSX V5 — Correctif Phase 11.1

## Navigation et maintien de session

- Le logo DanaTrap RSX dirige maintenant un utilisateur connecté vers son tableau de bord (`#/app`).
- Un visiteur non connecté continue d’être envoyé vers l’accueil public.
- Un utilisateur déjà connecté qui ouvre `/`, `/connexion` ou `/inscription` est automatiquement renvoyé vers son espace.
- La session Supabase est explicitement conservée dans le stockage local du navigateur.
- Le renouvellement automatique du jeton Supabase est activé.
- Le cache PWA est renouvelé afin de charger immédiatement le correctif.

Aucune migration SQL n’est nécessaire.
