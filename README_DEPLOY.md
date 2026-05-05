# Déploiement — Strate Radar (GitHub Actions nocturne)

Le workflow `.github/workflows/nightly-radar.yml` exécute la pipeline **toutes les nuits** (cron UTC), écrit `rapport_matinal.md`, `data/shadow-sites-export.json`, **`data/heartbeat.json`**, envoie les audits vers la vitrine via **`POST …/api/audits/ingest`** (secret `RADAR_INGEST_SECRET`), puis met à jour **`data/strate-radar.sqlite`** et tente un **commit + push**. Les pages HTML ne sont **pas** générées dans ce dépôt — la vitrine / site mère les construit à partir de l’API. Pour générer des HTML en local : `npm run generate:shadows`.

### Qui commit les fichiers radar sur `main` ?

**Seul ce workflow** est censé pousser ces artefacts (évite les conflits entre votre machine et le runner). En développement local :

1. Une fois après clone ou quand vous avez tiré `main`, exécutez **`npm run git:skip-radar-artifacts`**. Git ignorera alors les modifications locales sur le rapport, l’export JSON, le heartbeat et le SQLite : vous pouvez lancer **`npm run dev`** sans salir `git status` ni risquer de committer les mêmes fichiers que le bot.
2. Pour revoir l’état skip-worktree : **`npm run git:show-radar-artifacts`**.
3. Si vous devez **vraiment** committer une évolution sur ces fichiers à la main, ou resynchroniser après un pull qui les a mis à jour côté dépôt : **`npm run git:track-radar-artifacts`**, puis `git pull` / `git checkout` comme d’habitude, et éventuellement **`git:skip-radar-artifacts`** à nouveau.

Sans ça, le comportement par défaut reste « tout le monde peut modifier les mêmes chemins » → merges et rebases pénibles. Le workflow fait déjà **`git pull --rebase`** avant **`git push`** pour limiter les courses avec un push humain.

### Mémoire SQLite sur GitHub (important)

Le fichier **`data/strate-radar.sqlite`** est **versionné** dans le dépôt pour que chaque run CI réutilise la même base que le run précédent (fenêtre `RADAR_SQLITE_RECENT_DAYS`, outcomes diamant / disqualifié, cache PageSpeed par URL). Sans ça, chaque nuit repartait **à zéro** et consommait de nouveau les mêmes appels API.

- **Premier run** : la base est créée par la pipeline puis **ajoutée au commit** par le bot.
- Si **vous poussez sur `main`** pendant qu’un run nocturne tourne (~6 min d’API), le bot peut avoir besoin d’un **`git pull --rebase` avant `git push`** : c’est maintenant fait automatiquement dans le workflow. En cas de **conflit** (ex. SQLite modifié des deux côtés), le job échoue : résoudre à la main ou garder une version de la base.
- En local, `git pull` avant de travailler évite de diverger trop de la base « serveur ».

## Secrets GitHub (Settings → Secrets and variables → Actions)

| Secret | Obligatoire | Rôle |
|--------|-------------|------|
| `GOOGLE_PLACES_API_KEY` | Oui (mode live) | Clé [Places API](https://developers.google.com/maps/documentation/places/web-service/op-overview) — Text Search (pack local + résolution site). |
| `GOOGLE_PAGESPEED_API_KEY` | Oui (mode live) | Clé [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started). |
| `GROQ_API_KEY` | Oui (mode live) | Clé [Groq Console](https://console.groq.com/keys). |
| `TELEGRAM_BOT_TOKEN` | Non | [Bot Telegram](https://core.telegram.org/bots/tutorial) : token fourni par [@BotFather](https://t.me/BotFather) après `/newbot`. |
| `TELEGRAM_CHAT_ID` | Non | Identifiant du chat qui recevra le message (voir ci-dessous). |

> Les noms **doivent** correspondre à ceux du tableau (le code lit `GOOGLE_PLACES_API_KEY`, pas `PLACES_KEY`).

### Notification Telegram (téléphone)

1. Sur Telegram, ouvre **@BotFather** → `/newbot` → choisir un nom et un username → copier le **token** → secret GitHub `TELEGRAM_BOT_TOKEN`.
2. Démarre une conversation avec **ton bot** (touche Démarrer / envoie un message).
3. Récupère ton **chat id** : dans un navigateur, ouvre  
   `https://api.telegram.org/bot<TOKEN>/getUpdates`  
   (remplace `<TOKEN>` par le token) et repère `"chat":{"id": 123456789` → secret GitHub `TELEGRAM_CHAT_ID` (le nombre, peut être négatif pour un groupe).
4. Push le workflow : après chaque run **réussi**, tu reçois un message avec le nombre de pépites et le lien vers `rapport_matinal.md` sur GitHub. En cas d’échec, un message avec le lien vers les logs Actions.

Sans ces deux secrets, le workflow **ignore** l’étape Telegram (aucune erreur).

## Variables dépôt (optionnel, `vars`)

| Variable | Exemple | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Modèle Groq. |
| `RADAR_SEARCH_LOCATION` | `Annecy, France` | Zone passée dans `textQuery` Places (ville + pays). |
| `RADAR_DIAMOND_LOCATION_HINTS` | `annecy,chambéry` | Filtre zone « Diamant » (adresse / titre). |
| `RADAR_MAX_PLACES_REQUESTS_PER_RUN` | `150` | Plafond d’appels Places Text Search par run (garde-fou). L’ancien nom `RADAR_MAX_SERPAPI_REQUESTS` est encore lu si la nouvelle variable est absente. |

## Permissions Git

- Le job utilise `permissions: contents: write` et le `GITHUB_TOKEN` par défaut pour pousser sur le **même** dépôt.
- Si la branche `main` est **protégée**, le push peut échouer : créez un **Personal Access Token** avec `contents: write`, stockez-le en secret (ex. `RADAR_PUSH_TOKEN`) et remplacez l’étape `checkout` par un token personnalisé, ou assouplissez la protection pour `[bot]`.

## Horaire

Le cron est en **UTC** (`0 3 * * *` ≈ 04h Paris en hiver). Ajustez selon l’heure d’été ou vos préférences.

## Test manuel

Dans l’onglet **Actions** du dépôt : **Nightly Strate Radar** → **Run workflow**.
