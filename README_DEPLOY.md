# Déploiement — Strate Radar (GitHub Actions nocturne)

Le workflow `.github/workflows/nightly-radar.yml` exécute la pipeline **toutes les nuits** (cron UTC), écrit `rapport_matinal.md`, `data/shadow-sites-export.json`, les HTML dans `data/shadow-pages/` et met à jour **`data/strate-radar.sqlite`** (mémoire des lieux déjà traités / disqualifiés), puis tente un **commit + push** sur la branche courante.

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
| `SERPAPI_GOOGLE_DOMAIN` | `google.fr` | Domaine Google pour la France. |

## Permissions Git

- Le job utilise `permissions: contents: write` et le `GITHUB_TOKEN` par défaut pour pousser sur le **même** dépôt.
- Si la branche `main` est **protégée**, le push peut échouer : créez un **Personal Access Token** avec `contents: write`, stockez-le en secret (ex. `RADAR_PUSH_TOKEN`) et remplacez l’étape `checkout` par un token personnalisé, ou assouplissez la protection pour `[bot]`.

## Horaire

Le cron est en **UTC** (`0 3 * * *` ≈ 04h Paris en hiver). Ajustez selon l’heure d’été ou vos préférences.

## Test manuel

Dans l’onglet **Actions** du dépôt : **Nightly Strate Radar** → **Run workflow**.
