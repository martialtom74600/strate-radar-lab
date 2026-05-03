# Déploiement — Strate Radar (GitHub Actions nocturne)

Le workflow `.github/workflows/nightly-radar.yml` exécute la pipeline **toutes les nuits** (cron UTC), écrit `rapport_matinal.md`, `data/shadow-sites-export.json` et les HTML dans `data/shadow-pages/`, puis tente un **commit + push** sur la branche courante.

## Secrets GitHub (Settings → Secrets and variables → Actions)

| Secret | Obligatoire | Rôle |
|--------|-------------|------|
| `GOOGLE_PLACES_API_KEY` | Oui (mode live) | Clé [Places API](https://developers.google.com/maps/documentation/places/web-service/op-overview) — Text Search (pack local + résolution site). |
| `GOOGLE_PAGESPEED_API_KEY` | Oui (mode live) | Clé [PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started). |
| `GROQ_API_KEY` | Oui (mode live) | Clé [Groq Console](https://console.groq.com/keys). |

> Les noms **doivent** correspondre à ceux du tableau (le code lit `GOOGLE_PLACES_API_KEY`, pas `PLACES_KEY`).

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
