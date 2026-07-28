# DanaTrap RSX V5 — Correctif Phase 12.1

- La suppression d'une production est maintenant vérifiée côté Supabase avant d'annoncer le succès.
- Les productions en corbeille disparaissent immédiatement de toutes les listes normales.
- La page courante est rechargée même si l'URL ne change pas.
- Les erreurs de suppression sont affichées au lieu d'être silencieuses.
- La suppression d'un utilisateur résout aussi les anciens identifiants de profil.
- Le compte Auth est supprimé sans paramètre ambigu, puis contrôlé par une seconde lecture Supabase.
- Un nettoyage de secours des relations DanaTrap est effectué si une ancienne contrainte bloque la cascade.
- Les fichiers Google Drive des productions supprimées sont déplacés dans la corbeille.
