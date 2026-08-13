#!/usr/bin/env node
/**
 * Miroir des tickets — docs/tickets.md → issues GitHub.
 *
 * ── Pourquoi un miroir, et pas une migration ────────────────────────────
 * `docs/tickets.md` est la SOURCE DE VÉRITÉ : versionné avec le code, lu par
 * la page Système de l'application, utilisable hors ligne — c'est la doctrine
 * local-first du projet. Les issues GitHub sont sa VITRINE : visibles depuis
 * le dépôt public, on peut y discuter, s'y abonner. Déplacer les tickets sur
 * GitHub couperait l'application de son backlog et créerait deux vérités.
 *
 * ── Ce que fait le miroir (sens unique, fichier → issues) ───────────────
 *   - ticket ouvert sans issue        → l'issue est créée (labels type + prio) ;
 *   - ticket archivé, issue ouverte   → l'issue est fermée, avec un commentaire ;
 *   - titre changé dans le fichier    → l'issue est retitrée ;
 *   - ticket rouvert                  → l'issue est rouverte.
 * Les issues dont le titre ne commence pas par « T-nnn » ne sont JAMAIS
 * touchées : ce sont celles du public. Un retour d'utilisateur pertinent se
 * transcrit à la main dans docs/tickets.md — c'est là qu'il entre au backlog.
 * Les tickets déjà archivés n'engendrent pas d'issue : on ne peuple pas une
 * vitrine avec des étagères vides.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/refleter-tickets.mjs               montre le plan, ne touche à rien
 *   node scripts/refleter-tickets.mjs --appliquer   applique (CI, via `gh` + GH_TOKEN)
 *
 * Les deux modes exigent le CLI `gh` (présent d'origine sur les exécuteurs
 * GitHub) pour lister les issues existantes. La logique pure — analyse du
 * fichier, calcul du plan — est exportée et testée sans réseau
 * (scripts/refleter-tickets.test.mjs).
 */

import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATUTS_OUVERTS = new Set(["ouvert", "en cours"]);
const STATUTS_CLOS = new Set(["fait", "abandonné"]);

/** Couleurs des labels (celles de GitHub pour `bug`, sobres pour le reste). */
const COULEURS = {
  bug: "d73a4a",
  feat: "a2eeef",
  tech: "cfd3d7",
  doc: "0075ca",
  P1: "b60205",
  P2: "fbca04",
  P3: "c2e0c6",
};

/**
 * Lit les lignes de tableau « | T-nnn | type | prio | statut | titre | » (où
 * qu'elles soient : Ouverts comme Archivés — c'est la colonne Statut qui fait
 * foi, pas la section), puis rattache à chaque ticket sa section détaillée
 * « ### T-nnn — … ». Les mentions en prose (« voir T-005 ») ne matchent pas :
 * une ligne de tableau commence par `|`, une section par `###`.
 */
export function analyserTickets(markdown) {
  const tickets = [];
  const vus = new Set();
  for (const ligne of markdown.split("\n")) {
    const m = /^\|\s*(T-\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|(.+?)\|\s*$/.exec(ligne);
    if (!m) continue;
    if (vus.has(m[1])) throw new Error(`ticket en double dans les tableaux : ${m[1]}`);
    vus.add(m[1]);
    tickets.push({
      id: m[1],
      type: m[2].trim(),
      prio: m[3].trim(),
      statut: m[4].trim(),
      titre: m[5].trim(),
      corps: "",
    });
  }

  // Le corps s'arrête au prochain titre ou au séparateur `---` : le titre de
  // la section peut être une forme COURTE du titre du tableau, seul l'ID lie.
  const motifSection = /^### (T-\d+)[^\n]*\n([\s\S]*?)(?=^### |^## |^---$|(?![\s\S]))/gm;
  let section;
  while ((section = motifSection.exec(markdown)) !== null) {
    const ticket = tickets.find((t) => t.id === section[1]);
    if (ticket) ticket.corps = section[2].trim();
  }
  return tickets;
}

/**
 * Compare tickets et issues, rend la liste des actions. Pur : aucun réseau,
 * aucun ordre d'exécution caché — ce qui le rend testable et lisible dans le
 * journal de CI avant application.
 */
export function planifierMiroir(tickets, issues) {
  const issueParId = new Map();
  for (const issue of issues) {
    const m = /^(T-\d+)\b/.exec(issue.title);
    if (m && !issueParId.has(m[1])) issueParId.set(m[1], issue);
  }

  const actions = [];
  for (const t of tickets) {
    const ouvert = STATUTS_OUVERTS.has(t.statut);
    if (!ouvert && !STATUTS_CLOS.has(t.statut)) {
      throw new Error(`statut inconnu pour ${t.id} : « ${t.statut} »`);
    }
    const issue = issueParId.get(t.id);
    const titreVoulu = `${t.id} — ${t.titre}`;

    if (ouvert && !issue) {
      actions.push({ action: "creer", id: t.id, titre: titreVoulu, labels: [t.type, t.prio], corps: t.corps });
    } else if (ouvert && issue) {
      if (issue.state === "CLOSED") actions.push({ action: "rouvrir", id: t.id, numero: issue.number });
      if (issue.title !== titreVoulu) actions.push({ action: "retitrer", id: t.id, numero: issue.number, titre: titreVoulu });
    } else if (issue && issue.state === "OPEN") {
      actions.push({ action: "fermer", id: t.id, numero: issue.number, statut: t.statut });
    }
  }
  return actions;
}

const PIED =
  "\n\n---\n*Miroir automatique de `docs/tickets.md` — la **source de vérité**, versionnée avec" +
  " le code et lue par la page Système de l'application. La discussion est bienvenue ici ;" +
  " l'état du ticket, lui, se change dans le fichier, et le miroir suit au commit suivant.*";

/**
 * T-013 — le dépôt cible est NOMMÉ, jamais déduit du remote.
 *
 * En local, `origin` pointe vers la forge privée : `gh` répondait « none of
 * the git remotes […] point to a known GitHub host » et le miroir était
 * inutilisable hors CI (où le checkout installe un origin GitHub — la panne
 * était donc invisible là où le script tourne pour de vrai).
 */
export function depotCible(env = process.env) {
  return env.GH_REPO ?? "duvamduvam/iaction";
}

function gh(...args) {
  return execFileSync("gh", [...args, "--repo", depotCible()], {
    cwd: racine,
    encoding: "utf8",
  });
}

async function main() {
  const appliquer = process.argv.includes("--appliquer");
  const markdown = await fsp.readFile(path.join(racine, "docs", "tickets.md"), "utf8");
  const tickets = analyserTickets(markdown);
  const issues = JSON.parse(
    gh("issue", "list", "--state", "all", "--limit", "500", "--json", "number,title,state"),
  ).map((i) => ({ ...i, state: String(i.state).toUpperCase() }));

  const actions = planifierMiroir(tickets, issues);
  console.log(`Miroir des tickets : ${tickets.length} ticket(s), ${issues.length} issue(s), ${actions.length} action(s).`);
  for (const a of actions) {
    console.log(`  ${a.action} ${a.id}${a.numero ? ` (issue #${a.numero})` : ""}${a.titre ? ` — ${a.titre}` : ""}`);
  }
  if (!appliquer) {
    if (actions.length > 0) console.log("Lecture seule — relancer avec --appliquer pour exécuter.");
    return;
  }

  const labels = new Set(actions.filter((a) => a.action === "creer").flatMap((a) => a.labels));
  for (const label of labels) {
    gh("label", "create", label, "--color", COULEURS[label] ?? "ededed", "--force");
  }
  for (const a of actions) {
    if (a.action === "creer") {
      gh("issue", "create", "--title", a.titre, "--label", a.labels.join(","),
        "--body", (a.corps || "Voir `docs/tickets.md`.") + PIED);
    } else if (a.action === "fermer") {
      gh("issue", "close", String(a.numero), "--comment", `Clos dans docs/tickets.md (statut « ${a.statut} »).`);
    } else if (a.action === "rouvrir") {
      gh("issue", "reopen", String(a.numero));
    } else if (a.action === "retitrer") {
      gh("issue", "edit", String(a.numero), "--title", a.titre);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
