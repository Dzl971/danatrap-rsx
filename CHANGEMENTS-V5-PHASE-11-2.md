# DanaTrap RSX V5 — Correctif Phase 11.2

## Factures A4 sur une seule page

- ajoute une vraie page d’impression de 210 × 297 mm ;
- supprime les marges automatiques du navigateur avec `@page` ;
- conserve les couleurs et les fonds lors de l’export PDF ;
- mesure la hauteur réelle de la facture avant l’impression ;
- réduit automatiquement l’ensemble de la facture si son contenu dépasse la hauteur A4 ;
- centre le document après la réduction ;
- empêche les tableaux, signatures et autres blocs d’être coupés ;
- conserve le logo DanaTrap RSX activable ou désactivable ;
- renouvelle le cache PWA ;
- version API : `5.0.0-phase11.2`.

Aucune migration SQL n’est nécessaire.
