# DanaTrap RSX V5 — Correctif Phase 11.4

## Formulaires plus fluides

- L’aperçu de la production n’est plus reconstruit à chaque frappe clavier.
- Seuls les champs réellement visibles dans l’aperçu déclenchent son actualisation.
- Les champs texte utilisent une courte temporisation, sans bloquer la saisie.
- Les couleurs et curseurs restent presque instantanés.
- Le lourd `bind()` global n’est plus relancé depuis l’aperçu de production.
- Les panneaux hors écran sont rendus à la demande sur les grands écrans.

## Audit des autres pages

- Personnalisation du profil : aperçu temporisé.
- Aspect global : aperçu temporisé.
- Factures : aperçu A4 temporisé pendant la saisie.
- Brouillons automatiques : sérialisation différée pendant une période inactive du navigateur.
- Messagerie : événements « écrit… » limités pour ne plus envoyer une requête à chaque caractère.

## Version

`5.0.0-phase11.4`
