# Déploiement — Strate Radar (GitHub Actions nocturne)

Le workflow `.github/workflows/nightly-radar.yml` exécute la pipeline **toutes les nuits** (cron UTC), écrit `rapport_matinal.md`, `data/shadow-sites-export.json`, **`data/heartbeat.json`**, met à jour **`data/strate-radar.sqlite`** (hors dépôt), envoie les audits vers la vitrine via **`POST …/api/audits/ingest`** (secret `RADAR_INGEST_SECRET`), puis **enregistre la SQLite dans le cache GitHub Actions** et publie le rapport / JSON / heartbeat en **artefacts du run** (onglet *Summary* du workflow → section *Artifacts*). Ces fichiers sont listés dans **`.gitignore`** : plus de commit automatique, donc **plus de conflits** entre le bot et vos tests locaux (`npm run dev` régénère les mêmes chemins sans salir les merges).

Les pages HTML ne sont **pas** générées dans ce dépôt — la vitrine / site mère les construit à partir de l’API. Pour générer des HTML en local : `npm run generate:shadows`.

### Mémoire SQLite sur GitHub (important)

La base **`data/strate-radar.sqlite`** n’est **plus versionnée**. Entre deux nuits, elle est **restaurée puis sauvegardée** via `actions/cache` (clé préfixée par la branche). Premier run sur une branche : base vide puis remplie comme en local. Fenêtre `RADAR_SQLITE_RECENT_DAYS`, outcomes diamant / disqualifié et cache PageSpeed restent valables **tant que le cache Actions n’est pas purgé** (éviction côté GitHub ou changement de branche isolée).

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

1. Sur Telegram, ouvre **@BotFather** → `/newbot` → choisir un nom et un username → copier le **token** → secret Git `TELEGRAM_BOT_TOKEN`.
2. Démarre une conversation avec **ton bot** (touche Démarrer / envoie un message).
3. Récupère ton **chat id** : dans un navigateur, ouvre  
   `https://api.telegram.org/bot<TOKEN>/getUpdates`  
   (remplace `<TOKEN>` par le token) et repère `"chat":{"id": 123456789` → secret GitHub `TELEGRAM_CHAT_ID` (le nombre, peut être négatif pour un groupe).
4. Push le workflow : après chaque run **réussi**, tu reçois un message avec le nombre de leads et le **lien vers le run Actions** (artefacts : rapport, export, heartbeat). En cas d’échec, un message avec le lien vers les logs.

Sans ces deux secrets, le workflow **ignore** l’étape Telegram (aucune erreur).

## Variables dépôt (optionnel, `vars`)

| Variable | Exemple | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Modèle Groq. |
| `RADAR_SEARCH_LOCATION` | `Annecy, France` | Zone passée dans `textQuery` Places (ville + pays). |
| `RADAR_DIAMOND_LOCATION_HINTS` | `annecy,chambéry` | Filtre zone « Diamant » (adresse / titre). |
| `RADAR_MAX_PLACES_REQUESTS_PER_RUN` | `150` | Plafond d’appels Places Text Search par run (garde-fou). L’ancien nom `RADAR_MAX_SERPAPI_REQUESTS` est encore lu si la nouvelle variable est absente. |

## Permissions Git

- Le job utilise `permissions: contents: read` (plus de push des artefacts sur le dépôt).

## Horaire

Le cron est en **UTC** (`0 3 * * *` ≈ 04h Paris en hiver). Ajustez selon l’heure d’été ou vos préférences.

## Test manuel

Dans l’onglet **Actions** du dépôt : **Nightly Strate Radar** → **Run workflow**.
