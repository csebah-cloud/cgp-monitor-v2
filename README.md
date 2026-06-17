# CGP Monitor V2

Outil de veille et de prospection des cabinets de **Conseil en Gestion de Patrimoine (CGP)** en France.

Site statique (HTML/CSS/JS vanilla) servi par **GitHub Pages** depuis `docs/`, alimenté par un scraper Python
exécuté via **GitHub Actions**. Design « Santander Consumer » — propre, bancaire, épuré.

🔗 **Production : https://csebah-cloud.github.io/cgp-monitor-v2/**

> V1 historique : `lsebah/cgp-monitor` (https://lsebah.github.io/cgp-monitor/) — conservée intacte, compte distinct.

---

## Structure

```
docs/                     # racine GitHub Pages
  index.html              # structure (header sticky, 7 tuiles, 4 onglets, modals)
  style.css               # design system Santander (Inter, #EC0000, cards 16px, pills 24px)
  app.js                  # toute la logique (filtres, stats, sync, Folk, CSV, MAJ)
  sw.js                   # service worker AUTO-DESTRUCTEUR (non enregistré — défensif)
  data/
    members.json          # ~10 690 cabinets CGP (fichier principal, ~15 Mo)
    groupements.json      # fiches de référence des réseaux + associations
    new_members.json      # derniers cabinets détectés
    stats.json            # statistiques agrégées
    20260413_cartographie_groupements_cgp.json  # écosystème (Acteurs)
    folk_push.json        # file d'attente d'IDs à pousser vers Folk ([])
scraper/                  # scraper Python (sources CNCGP/CNCEF/ANACOFI/ORIAS/data.gouv…)
.github/workflows/        # scrape hebdo, découverte, ORIAS, push Folk
requirements.txt
```

## Onglets

- **Dashboard** — 4 cartes association (chaque cabinet compté dans **une seule** : `cncgp > cncef > anacofi > other`,
  somme = Total CGP) + derniers cabinets détectés.
- **Annuaire** — recherche plein texte + filtres repliables (association, département, activité, statut, groupement,
  date de création, CA, AUM, structure, expertise), tri par date de création, pagination « Charger plus » (50/page),
  statut + toggle Folk par fiche.
- **Acteurs** — cartographie de l'écosystème (associations agréées, groupements, réseaux capitalistiques, family
  offices, plateformes) + priorités de prospection CMF.
- **Groupements** — fiches de référence des réseaux CGP et associations professionnelles.

Les **7 tuiles** (Total, Créés < 7j, Créés < 4 mois, En cours, Contactés, Refus, Dans Folk) utilisent toutes la même
population « consultable » (cabinets avec email **ou** téléphone **ou** site **ou** dirigeants) et filtrent l'Annuaire au clic.

## État local (localStorage)

| Clé | Contenu |
|-----|---------|
| `cgpv2_statuses` | `{ [id]: { status, date } }` — statut de prospection |
| `cgpv2_folk` | `{ [id]: date }` — cabinets marqués pour Folk |
| `cgpv2_sync_config` | `{ gistId, token }` — synchro multi-appareils |
| `cgpv2_folk_api_key` | clé API Folk |

## Synchronisation multi-appareils (GitHub Gist)

Bouton **Sync** → Gist privé contenant `cgp-monitor-state.json` (statuts + marquages Folk). Renseigner le Gist ID et un
token GitHub avec le scope `gist`. Fusion non destructive (le local gagne en cas de conflit).

## Folk CRM

Le navigateur **ne peut pas** appeler l'API Folk (CORS). L'envoi se fait **côté serveur** :

1. Marquer les cabinets via le toggle « Folk » sur chaque fiche.
2. Cliquer **Push Folk** → télécharge `folk_push.json` (liste d'IDs).
3. Committer `folk_push.json` dans `docs/data/`, puis lancer le workflow GitHub **« Push to Folk CRM »**
   (`folk-push.yml`) en fournissant la clé API Folk en input. Le workflow vide ensuite la file.

> ⚠️ La clé API Folk ne doit **jamais** être committée : elle reste en localStorage côté navigateur ou est passée en
> input de workflow.

## Export CSV

Bouton **CSV** → exporte les **résultats filtrés** au format compatible Folk (une ligne par dirigeant, UTF-8 BOM pour Excel).

## Bouton MAJ (anti-cache)

Vide les caches (Service Worker + Cache API), pose un flag `sessionStorage`, puis recharge toute la page avec une URL
cache-bustée (`?_=<timestamp>`). Après rechargement : affiche l'heure du clic + confirmation verte « ✓ MAJ ».
Pas de Service Worker actif ; `sw.js` est présent uniquement pour neutraliser un éventuel SW résiduel.

---

## Déploiement GitHub Pages

Repo **Settings → Pages** : *Source* = `Deploy from a branch`, *Branch* = `main` / dossier `/docs`.

## Scraper

```bash
pip install -r requirements.txt
python -m playwright install --with-deps chromium
cd scraper && python main.py
```

Exécuté automatiquement chaque semaine (`.github/workflows/daily-scrape.yml`).
