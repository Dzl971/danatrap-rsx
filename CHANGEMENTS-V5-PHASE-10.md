# DanaTrap RSX V5 — Phase 10

## Automatisation et production finale

- Notifications transactionnelles par e-mail via Resend, avec préférences utilisateur.
- Rappels de réservation automatiques à 24 h et 2 h avant expiration.
- Expiration automatique des réservations et remise en disponibilité.
- Sauvegarde automatique quotidienne vers le dossier privé Google Drive.
- Corbeille Drive réelle et suppression définitive après 30 jours.
- Mode maintenance personnalisable depuis l’administration.
- Brouillons locaux automatiques et avertissement avant de quitter un formulaire.
- Centre de récupération des comptes : lien sécurisé ou mot de passe temporaire.
- Historique des licences et décisions affiché dans les réservations.
- Contrôle de santé enrichi : e-mail, automatisation, sauvegardes, Drive et Supabase.
- Route idempotente `/api/v1/jobs/tick` et exécution automatique en arrière-plan.
- Version API et cache : `5.0.0-phase10`.

## Configuration facultative après déploiement

Pour activer l’envoi réel d’e-mails, ajouter ultérieurement dans l’API Render :

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `PUBLIC_SITE_URL`

Le site continue de fonctionner sans ces variables ; seules les notifications e-mail restent désactivées.
