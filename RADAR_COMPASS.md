# RADAR COMPASS — Boussole produit (mode Creation Hunt)

Document de référence pour **Strate Radar**. Toute évolution du code doit servir ces règles — pas l’inverse.

**Dernière révision :** juin 2026  
**Mode visé :** `RADAR_CREATION_HUNT_MODE=true`, `RADAR_TARGET_REFONTE_COUNT=0`

---

## 1. Mission

Radar est une machine de prospection nocturne pour **Strate Studio**. Elle :

1. Découvre des commerces locaux sur Google Maps (Creation Hunt : métiers rotatifs + expansion géo).
2. Vérifie leur présence web (cascade unifiée pipeline + scrub).
3. Publie des **audits shadow** (diamants) sur la vitrine via `POST /api/audits/ingest`.

**Objectif business :** alimenter la prospection avec des commerces qui **méritent un site** — pas encore équipés d’un vrai site vitrine indépendant.

---

## 2. Checklist produit (règles strictes)

Un lead est **publiable** en Creation Hunt **uniquement si** toutes les conditions suivantes sont vraies.

### A. Cible (qui ?)

| # | Règle | Seuil code actuel |
|---|--------|-------------------|
| A1 | Commerce **local** et **unitaire** (artisan, commerçant, PME, pro libérale) | Gatekeeper Groq pre-flight + préfiltre titre/catégorie Maps |
| A2 | **Zéro franchise / réseau national** (Carrefour, Nocibé, Century 21, etc.) | Statut `corporate_parent` → rejet |
| A3 | **Bonne réputation Maps** | `> 5` avis **et** note `> 3,5` (`hasCreationReputation`) |
| A4 | Dans la **zone géographique** configurée | Creation Hunt + `RADAR_DIAMOND_LOCATION_HINTS` |

### B. Présence web (condition absolue — définition stricte)

Le commerce ne doit avoir **strictement rien** qui ressemble à un site vitrine — y compris un bricolage Wix/Webnode. Cible : celui qui **n'a rien du tout** (ou seulement une présence tierce passive).

| Statut | Signification | Diamant ? |
|--------|---------------|-----------|
| `none` | Aucune présence web détectée | **DIAMANT_CREATION** |
| `presence_only` | Uniquement annuaire / réseau social / plateforme tierce (Mappy, Instagram, PagesJaunes…) | **DIAMANT_PRESENCE** (sauf exclusions ci-dessous) |

Présence web **interdite** (rejet immédiat en Creation Hunt) :

| Statut | Signification |
|--------|---------------|
| `owner_site` | Site confirmé — **domaine dédié** (`mon-plombier.fr`) **ou hébergeur** (Webnode, Wix, Jimdo…). Classés `owner_site`, pas `corporate_parent` : l'artisan a investi du temps émotionnel, ce n'est pas notre cible. |
| `corporate_parent` | Succursale ou fiche sur le site d'un **réseau / enseigne nationale** |

### C. Exclusions présence tierce (policy)

| Plateforme | Règle |
|------------|--------|
| Doctolib, Planity, Maiia, TheFork… | **Toujours exclu** (règle non désactivable) |
| Facebook, PagesJaunes, Mappy… | Exclu si `RADAR_PRESENCE_SKIP_POLICY=all_presence` ; **accepté** en défaut `booking_platforms` |

### D. Action (si OK)

- Génération d’un audit shadow (badge **DIAMANT_CREATION** ou **DIAMANT_PRESENCE**).
- Score Strate forcé à 100/100 (pas de matrice refonte).
- Ingest vitrine + notification Telegram.

---

## 3. Arbre de décision (Creation Hunt)

```
Fiche Maps
    │
    ├─ Préfiltre (parking, mairie, marché couvert…) ──────────────► DISQUALIFIÉ
    │
    ├─ Gatekeeper Groq (pas commerce unitaire) ───────────────────► DISQUALIFIÉ
    │
    ├─ Réputation Maps insuffisante ──────────────────────────────► DISQUALIFIÉ
    │
    └─ Cascade web (Maps → Details → Serp → Brave → Groq → Top5)
            │
            ├─ owner_site (domaine dédié ou hébergeur Wix/Webnode…) ──► DISQUALIFIÉ
            ├─ corporate_parent (franchise / réseau) ───────────► DISQUALIFIÉ
            ├─ needs_review ──────────────────────────────────────► QUARANTAINE (pas d’ingest auto)
            │
            ├─ none + réputation OK ──────────────────────────────► 💎 CRÉATION
            └─ presence_only + réputation OK + policy OK ─────────► 💎 PRÉSENCE
```

**Refonte (`DIAMANT_REFONTE`) :** hors scope Creation Hunt (`RADAR_TARGET_REFONTE_COUNT=0`).

---

## 4. Ce qu’on ne cherche PAS

- Enseignes nationales, franchises, succursales.
- Entités publiques, marchés, parkings, collectifs multi-vendeurs.
- Commerces avec un **vrai site** sur domaine propre.
- Maximiser le volume au détriment de la précision.

---

## 5. Couches techniques (référence, pas liste d’heuristiques)

Une seule cascade partagée par le pipeline nocturne et le scrub rétroactif (`evaluateDiamondWebsitePresence`) :

```
Maps (lien fiche)
  → Place Details
  → Google organique (Serper)
  → Brave Search
  → Classifieur Groq (URLs SERP)
  → Top 5 Scanner (Jina Reader + Groq 70B)
```

**Principe d’architecture :** signaux **structurels** (domaine parent partagé, chemin profond, alignement nom↔domaine) + **sémantique Groq** — **pas** de blocklist de marques retail.

### Garde-fous stabilisés (juin 2026)

| Garde-fou | Fichier | Rôle |
|-----------|---------|------|
| Whitelist hébergeurs (Webnode, Wix…) | `website-builder-hosts.ts` | Ne **pas** classer en `corporate_parent` ; reconnaître vitrine artisan sur hébergeur |
| Footprints presse / annuaire | `top5-corporate-signals.ts` | Ne **pas** confondre article de presse ou listing annuaire avec franchise |
| Détection réseau structurelle | `top5-corporate-signals.ts` | ≥2 fiches branche même domaine parent → `corporate_parent` |
| Rescue domaine aligné | `top5-corporate-signals.ts` | Homepage alignée + doute Groq contenu → `owner_site` (rejet création) |
| Scrub rétroactif | `retroactive-scrub.ts` | Révoquer les diamants publiés avant correction |

---

## 6. Audit code vs boussole (juin 2026)

### Aligné avec la checklist

| Règle produit | Implémentation | Confiance |
|---------------|----------------|-----------|
| Pas de franchise / réseau | `corporate_parent` (Top5 + classifieur Groq + shared locator) | ~95 % |
| Pas de site domaine dédié | Rejet `owner_site` en chasse création | ~95 % |
| Réputation Maps minimale | `hasCreationReputation` | 100 % |
| Commerce unitaire local | Gatekeeper + préfiltre Maps | ~90 % |
| Pas de refonte en Creation Hunt | Quota refonte = 0 | 100 % |
| RDV en ligne exclus | `booking_platforms` (hard) | ~98 % |
| Presse / annuaire ≠ franchise | Footprints markdown + Groq directory-only | ~95 % |
| Webnode/Wix → `owner_site` | Whitelist builders : pas `corporate_parent`, rejet création via `owner_site` | 100 % (volontaire) |

### Écarts connus (~5 % résiduel — **ne pas empiler d’heuristiques**)

| Écart | Détail | Action |
|-------|--------|--------|
| **`needs_review`** | Doute IA ou erreur API → quarantaine manuelle | Triage scrub ; pas de patch regex |
| **Gatekeeper fallback** | Si Groq indisponible, la fiche passe par défaut | Acceptable ; rare en prod |
| **Blocklist immobilier** | `CORPORATE_NETWORK_DOMAINS` (~7 réseaux) dans `host-presence.ts` | Couverture partielle ; le reste passe par signaux structurels |
| **Faux négatif domaine dédié** | Site artisan non détecté (SERP pauvre, pas de Top5) | Risque faible ; surveiller scrub |

### Décision produit figée — hébergeurs (Webnode, Wix…)

**Règle :** un artisan sur Webnode/Wix a un coût irrécupérable émotionnel sur son bricolage. Ce n'est **pas** une cible Creation Hunt.

**Comportement code (intentionnel) :**
- Whitelist builders → **pas** `corporate_parent` (classification correcte).
- Contenu confirmé → `owner_site` → **rejet** pipeline Creation Hunt.

→ **Ne pas reclasser en `presence_only`. Capot fermé.**

---

## 7. Verdict : on s’arrête là ?

**Oui — pour le Radar en Creation Hunt, on fige la stack actuelle.**

Les deux correctifs **Builders whitelist** + **Footprints presse/annuaire**, combinés au patch **corporate_parent structurel** (commits `91e1c00`, `4275e4e`, `d641f9e`), couvrent **~95 %** de la checklist produit.

**Ligne d’arrêt :**

- ✅ Continuer les **runs nocturnes** et le **scrub** sur le stock existant.
- ✅ Corriger **uniquement** les échecs **systématiques** prouvés par le triage scrub (pas de patch au cas par cas).
- ❌ Ne plus ajouter de regex, blocklists marques ou raccourcis Carrefour-spécifiques.
- ❌ Ne pas rouvrir la détection web sans mise à jour **explicite** de ce document.

---

## 8. Configuration recommandée (production)

```env
RADAR_CREATION_HUNT_MODE=true
RADAR_TARGET_CREATION_COUNT=5
RADAR_TARGET_REFONTE_COUNT=0
RADAR_PRESENCE_SKIP_POLICY=booking_platforms
RADAR_TOP5_SCANNER=true
```

---

## 9. Fichiers de référence

| Fichier | Rôle |
|---------|------|
| `src/pipeline/radar-pipeline.ts` | Orchestration, quotas, rejet création |
| `src/lib/diamond-website-detection.ts` | Règles rejet chasse création / scrub |
| `src/lib/website-resolver.ts` | Cascade présence web |
| `src/lib/ai/top5-scanner.ts` | Dernière couche Jina + Groq |
| `src/lib/ai/top5-corporate-signals.ts` | Franchise, presse, builders, rescue |
| `src/lib/website-builder-hosts.ts` | Whitelist hébergeurs |
| `src/lib/gatekeeper.ts` | Filtre commerce unitaire |
| `src/lib/diamond.ts` | Seuils réputation Maps |
| `src/lib/retroactive-scrub.ts` | Scrub rétroactif diamants publiés |

---

## 10. Maintenance

| Rituel | Commande / lieu |
|--------|-----------------|
| Run nocturne | GitHub Actions `nightly-radar.yml` |
| Audit one-shot | `npm run audit:one -- "Nom" "Ville, France"` |
| Scrub stock | `npm run scrub -- --limit N` |
| Triage | `data/scrub-triage-latest.json` |

**Modifier la boussole :** éditer ce fichier en premier, puis une seule PR ciblée — jamais l’inverse.
