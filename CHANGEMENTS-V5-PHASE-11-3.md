# DanaTrap RSX V5 - Correctif Phase 11.3

## Mise en page finale des factures A4

- conserve la facture sur une seule page A4 portrait de 210 x 297 mm ;
- place le bandeau DanaTrap RSX au vrai bas de la page ;
- supprime le grand espace blanc qui apparaissait sous le bandeau ;
- ajuste uniquement le contenu central lorsqu'une facture est trop longue, sans rétrécir le pied de page ;
- attend le chargement de la photo et des signatures avant de calculer la mise en page ;
- corrige le retour à la ligne isolé du signe deux-points dans « Montant total de la facture » ;
- stabilise les colonnes du tableau et les textes longs ;
- évite que les signatures touchent ou dépassent le pied de page ;
- corrige le décalage d'un jour des dates saisies au format AAAA-MM-JJ, notamment en Guadeloupe ;
- renouvelle le cache PWA ;
- version API : `5.0.0-phase11.3`.

Aucune migration SQL n'est nécessaire.
