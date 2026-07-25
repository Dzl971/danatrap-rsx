# DanaTrap RSX V5 — Phase 2

Cette phase connecte l'interface V4.5 aux fondations Supabase V5 déjà installées.

## Fonctionnalités activées

- Rôles multiples sur un même compte : Beatmaker, Artiste, Producteur, Ingénieur du son et Manager.
- Permission Administrateur séparée des rôles publics.
- Le compte Dzl 971 peut donc apparaître comme `Admin · Beatmaker`.
- Réservation atomique via `reserve_beat_v5` avec expiration après 48 heures.
- Protection contre les doubles réservations.
- Liste d'attente automatique si une production est déjà réservée.
- Compte à rebours visible sur chaque réservation active.
- Acceptation et refus via `decide_reservation_v5`.
- Annulation côté artiste via `cancel_reservation_v5`.
- Après refus, annulation ou expiration, la production repasse automatiquement en `Publié`.
- Notification automatique de l'artiste et du prochain membre en liste d'attente.
- Messages de statut illustrés avec la couverture originale de la production.
- Couvertures originales dans les notifications et les listes de réservation.
- Gestion des rôles multiples dans l'administration.
- Mise à jour Realtime des réservations et événements.

## Version

- Frontend : V5 Phase 2
- API Render : `5.0.0-phase2`
- Migration requise : `5.0.0-phase1` déjà exécutée dans Supabase
