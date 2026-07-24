# Mettre DanaTrap RSX en ligne sur Render — pas à pas

Suis les étapes dans l’ordre. Ne publie jamais tes clés privées dans GitHub.

---

# Étape 0 — Ce qu’il te faut

Crée ou prépare ces comptes :

1. un compte GitHub ;
2. un compte Render connecté à GitHub ;
3. un compte Supabase ;
4. ton compte Google qui possède les 2 To de Drive ;
5. Node.js 20 ou supérieur sur ton ordinateur pour générer le refresh token Google.

Décompresse le ZIP dans un dossier simple, par exemple :

```text
C:\DanaTrap-RSX-Render
```

Tu peux ouvrir `LANCER-DEMO.bat` pour vérifier le site avant sa mise en ligne.

---

# Étape 1 — Créer la base Supabase

## 1.1 Créer le projet

1. Connecte-toi à Supabase.
2. Clique sur **New project**.
3. Choisis ton organisation.
4. Nom du projet : `danatrap-rsx`.
5. Crée un mot de passe de base de données fort et conserve-le.
6. Choisis une région proche, par exemple Europe de l’Ouest.
7. Lance la création du projet.

## 1.2 Installer le schéma

1. Dans Supabase, ouvre **SQL Editor**.
2. Clique sur **New query**.
3. Ouvre localement le fichier `supabase/schema.sql`.
4. Copie tout son contenu.
5. Colle-le dans Supabase.
6. Clique sur **Run**.
7. Vérifie qu’aucune erreur rouge ne reste affichée.

Ce script crée les profils, productions, licences, réservations, conversations, messages, notifications, favoris, playlists, collaborations et règles RLS.

## 1.3 Récupérer les clés

Dans Supabase, ouvre les paramètres du projet puis la partie **API / Data API / API Keys** selon l’interface affichée.

Conserve séparément :

```text
SUPABASE_URL
SUPABASE_ANON_KEY ou Publishable key
SUPABASE_SERVICE_ROLE_KEY
```

La clé `service_role` est privée. Ne la mets jamais dans `frontend/config.js` ni dans GitHub.

## 1.4 Configurer l’authentification pour les premiers essais

Dans **Authentication > Providers > Email** :

- laisse l’inscription par e-mail activée ;
- pour tester plus simplement, tu peux temporairement désactiver la confirmation obligatoire des e-mails ;
- tu pourras la réactiver lorsque tes e-mails de confirmation seront correctement configurés.

L’adresse publique Render n’existe pas encore. Nous reviendrons sur **URL Configuration** après le déploiement.

---

# Étape 2 — Connecter ton Google Drive de 2 To

## 2.1 Créer le projet Google Cloud

1. Ouvre Google Cloud Console.
2. Crée un projet nommé `DanaTrap RSX`.
3. Ouvre **APIs & Services > Library**.
4. Recherche **Google Drive API**.
5. Clique sur **Enable**.

## 2.2 Configurer l’écran OAuth

1. Ouvre **Google Auth Platform** ou **OAuth consent screen**.
2. Choisis un type d’utilisateur **External** si tu utilises un compte Google personnel.
3. Nom de l’application : `DanaTrap RSX`.
4. Mets ton adresse e-mail en assistance utilisateur et contact développeur.
5. Ajoute le scope :

```text
https://www.googleapis.com/auth/drive.file
```

6. Pendant les essais, ajoute ton propre compte Google dans les utilisateurs de test.

### Très important

Un projet OAuth externe laissé avec le statut **Testing** peut fournir un refresh token qui expire au bout de 7 jours. Avant l’utilisation publique durable, passe le statut de publication à **Production**. Tu resteras le seul compte Google autorisé à gérer ton stockage : les utilisateurs du site n’auront jamais accès à ton Drive personnel.

## 2.3 Créer l’identifiant OAuth

1. Ouvre **Credentials**.
2. Clique sur **Create credentials > OAuth client ID**.
3. Type d’application : **Desktop app**.
4. Nom : `DanaTrap Drive Connector`.
5. Copie :

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

## 2.4 Générer le refresh token et les dossiers

1. Ouvre le dossier du projet dans l’Explorateur Windows.
2. Double-clique sur `CREER-CONNEXION-DRIVE.bat`.
3. Entre le Client ID puis le Client Secret.
4. Une adresse Google s’affiche dans le terminal.
5. Copie cette adresse dans ton navigateur.
6. Connecte-toi avec le compte qui possède les 2 To.
7. Autorise DanaTrap RSX.
8. Reviens au terminal.

Le script crée automatiquement :

```text
DanaTrap RSX/
├── Previews
├── Images
└── Fichiers privés
```

Le terminal affiche ensuite :

```text
GOOGLE_REFRESH_TOKEN
DRIVE_ROOT_FOLDER_ID
DRIVE_PREVIEWS_FOLDER_ID
DRIVE_IMAGES_FOLDER_ID
DRIVE_PRIVATE_FOLDER_ID
```

Copie ces cinq valeurs dans un bloc-notes privé. Ne les envoie à personne.

---

# Étape 3 — Mettre le projet sur GitHub

## Méthode simple avec GitHub Desktop

1. Installe et ouvre GitHub Desktop.
2. Clique sur **File > Add local repository**.
3. Sélectionne le dossier décompressé `DanaTrap-RSX-Render`.
4. Si GitHub Desktop indique que le dossier n’est pas encore un dépôt, clique sur **Create a repository**.
5. Nom : `danatrap-rsx`.
6. Vérifie que le fichier `render.yaml` est bien à la racine.
7. Fais le premier commit avec le message :

```text
DanaTrap RSX V4 Render
```

8. Clique sur **Publish repository**.
9. Tu peux laisser le dépôt **Private**.

## Méthode PowerShell

Dans le dossier du projet :

```powershell
git init
git add .
git commit -m "DanaTrap RSX V4 Render"
git branch -M main
git remote add origin ADRESSE_DE_TON_DEPOT_GITHUB
git push -u origin main
```

Avant le push, vérifie qu’aucun fichier `.env` contenant tes secrets n’a été ajouté.

---

# Étape 4 — Créer automatiquement les services sur Render

## 4.1 Lancer le Blueprint

1. Connecte-toi à Render.
2. Clique sur **New +**.
3. Choisis **Blueprint**.
4. Connecte ton compte GitHub si nécessaire.
5. Sélectionne le dépôt `danatrap-rsx`.
6. Render détecte le fichier `render.yaml`.
7. Clique sur **Apply** ou **Deploy Blueprint**.

Render doit préparer deux services :

```text
danatrap-rsx-site   → Static Site
danatrap-rsx-api    → Web Service Node.js
```

## 4.2 Remplir les variables demandées

### Variables du Static Site

```text
DRSX_SUPABASE_URL       = ton SUPABASE_URL
DRSX_SUPABASE_ANON_KEY  = ta clé anon ou Publishable
```

L’adresse de l’API et celle du site sont reliées automatiquement par Render.

### Variables du Web Service

```text
ALLOWED_ORIGINS                = *
SUPABASE_URL                   = ton SUPABASE_URL
SUPABASE_ANON_KEY              = ta clé anon ou Publishable
SUPABASE_SERVICE_ROLE_KEY      = ta clé service_role
GOOGLE_CLIENT_ID               = ton Client ID Google
GOOGLE_CLIENT_SECRET           = ton Client Secret Google
GOOGLE_REFRESH_TOKEN           = le refresh token généré
DRIVE_ROOT_FOLDER_ID           = l’ID affiché par le script
DRIVE_PREVIEWS_FOLDER_ID       = l’ID affiché par le script
DRIVE_IMAGES_FOLDER_ID         = l’ID affiché par le script
DRIVE_PRIVATE_FOLDER_ID        = l’ID affiché par le script
MAX_UPLOAD_BYTES               = 5368709120
```

`MAX_UPLOAD_BYTES` correspond à 5 Gio par fichier. Tu peux mettre une valeur plus basse pour limiter les très gros envois.

`FILE_SIGNING_SECRET` est généré automatiquement par Render.

Pour le premier déploiement, laisse `ALLOWED_ORIGINS` à `*`, car tu ne connais pas encore l’adresse finale du Static Site.

## 4.3 Attendre les deux déploiements

Dans Render :

1. ouvre `danatrap-rsx-api` ;
2. attends le statut **Live** ;
3. ouvre son URL suivie de `/health`.

Exemple :

```text
https://danatrap-rsx-api.onrender.com/health
```

Tu dois obtenir quelque chose comme :

```json
{"ok":true,"service":"DanaTrap RSX Render API","configured":true}
```

Puis ouvre `danatrap-rsx-site`. Le site doit s’afficher en mode réel, sans les comptes de démonstration préremplis.

---

# Étape 5 — Sécuriser les domaines après le déploiement

## 5.1 Restreindre l’API à ton site

1. Copie l’adresse exacte de `danatrap-rsx-site`.
2. Ouvre Render > `danatrap-rsx-api` > **Environment**.
3. Remplace :

```text
ALLOWED_ORIGINS=*
```

par :

```text
ALLOWED_ORIGINS=https://ADRESSE-EXACTE-DU-SITE.onrender.com
```

4. Enregistre et laisse Render redéployer l’API.

Si tu ajoutes plus tard un nom de domaine, tu peux autoriser plusieurs adresses séparées par des virgules.

## 5.2 Ajouter l’adresse dans Supabase

Dans **Authentication > URL Configuration** :

- **Site URL** : adresse exacte du Static Site Render ;
- **Redirect URLs** : ajoute l’adresse exacte du site et, si l’interface le permet, sa variante avec `/**`.

Exemple :

```text
https://danatrap-rsx-site.onrender.com
https://danatrap-rsx-site.onrender.com/**
```

---

# Étape 6 — Créer ton compte administrateur Dzl 971

## 6.1 Créer le compte depuis le site

1. Ouvre le site Render.
2. Clique sur **Créer un compte**.
3. Nom public : `Dzl 971`.
4. Utilise ton véritable e-mail administrateur.
5. Choisis un mot de passe fort.
6. Confirme ton e-mail si Supabase le demande.

## 6.2 Donner le rôle Admin

Dans Supabase > SQL Editor, exécute en remplaçant l’adresse :

```sql
update public.profiles
set role='Admin', verified=true, name='Dzl 971'
where user_id=(
  select id from auth.users where email='TON-EMAIL-ADMIN'
);
```

Ensuite, dans Render, remplace si nécessaire :

```text
DRSX_ADMIN_EMAIL
ADMIN_EMAIL
```

par cette même adresse, puis redéploie les deux services.

Déconnecte-toi et reconnecte-toi. L’onglet Administration doit apparaître.

---

# Étape 7 — Faire le premier test complet

Utilise deux navigateurs ou un navigateur normal et une fenêtre privée.

## Compte Beatmaker

1. Crée un compte Beatmaker.
2. Personnalise le profil.
3. Ajoute une production.
4. Importe une pochette.
5. Importe un MP3 de préécoute.
6. Importe éventuellement WAV, FLP, ZIP ou stems.
7. Ajoute et personnalise les licences.
8. Passe la visibilité à **Publié**.

Vérifie dans ton Drive que les fichiers apparaissent dans les bons dossiers.

## Compte Artiste

1. Crée un compte Artiste dans l’autre navigateur.
2. Ouvre la production.
3. Choisis une licence.
4. Clique sur **Réserver**.
5. Écris un message.

## Retour Beatmaker

1. Vérifie la notification.
2. Ouvre la conversation créée automatiquement.
3. Vérifie le bloc avec la production et la licence.
4. Discute avec l’artiste.
5. Si la production est prise définitivement, ouvre l’éditeur et passe sa visibilité à **Expiré**.

## Compte Admin

Vérifie que Dzl 971 peut :

- consulter tous les utilisateurs ;
- modifier leurs rôles ;
- supprimer un compte ;
- modifier ou supprimer une production ;
- consulter toutes les réservations.

---

## Validation visuelle finale

Après le premier test fonctionnel, ouvre le site sur :

- Chrome sur ordinateur ;
- Chrome ou Firefox sur Android ;
- Safari sur iPhone si possible.

Vérifie particulièrement les transitions, le lecteur fixe, la navigation mobile, les formulaires d’upload et les pages personnalisées. Les tests automatisés du ZIP vérifient les routes et les actions principales, mais ils ne remplacent pas ce contrôle visuel sur tes appareils.

---

# Étape 8 — Mettre à jour le site plus tard

Après une modification locale :

```powershell
git add .
git commit -m "Description de la mise à jour"
git push
```

Render redéploie automatiquement le service concerné.

- modification dans `frontend/` : Static Site redéployé ;
- modification dans `backend/render-api/` : API redéployée ;
- modification de `render.yaml` : synchronisation du Blueprint.

---

# Étape 9 — Limites de la solution gratuite

Le lancement peut fonctionner sans abonnement Render supplémentaire, mais il ne faut pas considérer les offres gratuites comme illimitées :

- le Web Service Render gratuit peut se mettre en veille après une période sans trafic ;
- le premier appel peut être plus lent pendant son redémarrage ;
- Supabase gratuit possède des quotas et peut mettre en pause un projet inactif ;
- Google Drive reste ton stockage principal ;
- ton espace de 2 To dépend de ton abonnement Google existant ;
- Google peut faire évoluer ses quotas API ;
- ne diffuse pas les fichiers WAV, FLP ou stems comme des liens publics permanents.

Le site réveille discrètement l’API à son ouverture. Les préécoutes et images passent par des liens signés, tandis que les fichiers de travail restent privés.

---

# Dépannage rapide

## Le site affiche encore les comptes de démonstration

Le build n’a pas reçu toutes les variables :

```text
DRSX_SUPABASE_URL
DRSX_SUPABASE_ANON_KEY
DRSX_API_URL
```

`DRSX_API_URL` doit être reliée automatiquement par le Blueprint. Vérifie les variables du Static Site puis lance **Manual Deploy > Clear build cache & deploy**.

## `/health` affiche `configured:false`

Une ou plusieurs variables privées manquent dans le Web Service. Le JSON indique uniquement le nom des variables manquantes, jamais leur valeur.

## Google affiche `invalid_grant`

Le refresh token est expiré ou révoqué. Relance `CREER-CONNEXION-DRIVE.bat`, remplace `GOOGLE_REFRESH_TOKEN` dans Render et redéploie.

## L’upload s’arrête

- vérifie que l’API est **Live** ;
- ouvre `/health` pour la réveiller ;
- vérifie le quota Drive ;
- vérifie que le fichier fait moins que les limites de ton compte ;
- relance l’upload.

## Erreur CORS

Vérifie que `ALLOWED_ORIGINS` contient exactement l’adresse du site, avec `https://` et sans slash final.
