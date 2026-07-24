# Tests et limites de la version Render

## Vérifications automatisées effectuées

- syntaxe de `frontend/assets/app.js` ;
- syntaxe de `frontend/assets/data-service.js` ;
- syntaxe du Service Worker ;
- syntaxe de l’API Node.js ;
- génération automatique de `config.js` avec les variables Render ;
- chargement et validation du `render.yaml` ;
- démarrage local de l’API Node.js ;
- réponse JSON de `GET /health` ;
- réponse 404 des routes inconnues ;
- présence de tous les fichiers utilisés par `frontend/index.html` ;
- rendu automatisé des principales routes publiques, Beatmaker, Artiste et Admin dans un DOM de test ;
- parcours de réservation en mode démonstration : choix d’une licence, notification du beatmaker, création automatique de la conversation, message-bloc de production, acceptation et passage en **Expiré** ;
- conservation du mode démonstration local ;
- adaptation des appels upload et administration vers l’API Render ;
- contrôle d’autorisation des uploads et limite de taille configurable.

## Vérifications à faire après ton déploiement

Ces tests nécessitent tes comptes et tes secrets personnels :

- inscription, confirmation d’e-mail et connexion réelles Supabase ;
- upload réel vers ton Google Drive ;
- lecture d’une préécoute via un lien signé ;
- notifications temps réel entre deux appareils ;
- création et suppression réelles d’utilisateurs par Dzl 971 ;
- vérification visuelle finale sur Chrome, Android et iPhone ;
- vérification du quota exact de ton compte Drive ;
- déploiement final dans ton propre workspace Render.

## Limites à connaître

- un Web Service Render gratuit peut redémarrer après une période sans trafic ;
- un upload interrompu par un redémarrage doit être relancé depuis l’interface ;
- le site n’enregistre aucun fichier sur le disque Render, car ce disque n’est pas persistant sur l’offre gratuite ;
- les fichiers restent dans Google Drive, tandis que Supabase stocke uniquement leurs métadonnées et identifiants ;
- la limite serveur du ZIP est réglée à 5 Gio par fichier avec `MAX_UPLOAD_BYTES` et peut être réduite dans Render ;
- un projet OAuth Google laissé en statut **Testing** peut produire un refresh token expirant au bout de 7 jours ;
- les offres gratuites Render et Supabase comportent des quotas et ne sont pas des ressources illimitées.

## Secrets

Aucun secret réel n’est présent dans le ZIP. Les valeurs privées doivent être saisies uniquement dans Render.
