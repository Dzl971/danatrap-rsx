# Déploiement DanaTrap RSX en un clic

Tu n'as plus besoin d'ouvrir GitHub dans le navigateur ni GitHub Desktop pour chaque mise à jour.

## Utilisation normale

1. Modifie les fichiers du site dans ton dossier `danatrap-rsx`.
2. Double-clique sur `DEPLOYER-DANATRAP.bat`.
3. Vérifie la liste des fichiers modifiés.
4. Confirme avec `O`.
5. Écris un message décrivant la modification, ou appuie directement sur Entrée.
6. Attends le message `Déploiement envoyé avec succès`.

Le programme exécute automatiquement :

```text
git add -A
git commit
git pull --rebase
git push origin main
```

Comme les deux services Render sont réglés sur l'auto-déploiement lors d'un commit, le push redéploie automatiquement :

- `danatrap-rsx-site`
- `danatrap-rsx-api`

## Première utilisation

Le script utilise l'authentification Git déjà configurée par GitHub Desktop. Lors du premier push, Windows peut ouvrir une demande de connexion GitHub. Accepte-la une seule fois.

Le script cherche automatiquement Git dans :

- le `PATH` Windows ;
- Git for Windows ;
- l'installation intégrée de GitHub Desktop.

## Sécurité

Avant le push, le programme recherche des clés privées fréquentes dans les fichiers modifiés. Il bloque le déploiement s'il détecte notamment :

- une clé Supabase `sb_secret_...` ;
- un `GOOGLE_CLIENT_SECRET` réel ;
- un `GOOGLE_REFRESH_TOKEN` réel ;
- un `FILE_SIGNING_SECRET` réel.

Conserve toujours les secrets dans Render, jamais dans les fichiers du dépôt.

## Utilisation depuis un terminal

```powershell
py -3 DEPLOYER-DANATRAP.py
```

Avec un message défini directement :

```powershell
py -3 DEPLOYER-DANATRAP.py "Amélioration de la page profil"
```

Sans demande de confirmation :

```powershell
py -3 DEPLOYER-DANATRAP.py "Correction lecteur audio" --yes
```

## Ce que le script ne modifie pas

Les variables d'environnement secrètes restent gérées dans Render. Le script déploie les changements de code et de fichiers. Une modification directe d'une clé Google, Supabase ou d'une variable Render doit toujours être effectuée dans l'espace `Environment` de Render.
