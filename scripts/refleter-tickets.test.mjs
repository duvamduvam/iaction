/**
 * Tests du miroir des tickets (logique pure : analyse + plan, aucun réseau).
 *
 * Le dernier bloc teste le VRAI docs/tickets.md : c'est lui qui verrouille le
 * format. Une ligne de tableau malformée ou un statut inventé casseraient le
 * miroir en CI, silencieusement côté poste — ici, ça casse `npm run verif`.
 *
 * Lancement : node scripts/refleter-tickets.test.mjs
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyserTickets, depotCible, planifierMiroir } from "./refleter-tickets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let reussites = 0;
let echecs = 0;

function verifier(intitule, condition, detail = "") {
  if (condition) {
    reussites += 1;
    return;
  }
  echecs += 1;
  console.error(`ECHEC: ${intitule}${detail ? ` — ${detail}` : ""}`);
}

const EXEMPLE = `# Exemple — tickets

## Convention

- **ID** : \`T-001\`, incrémental (mention en prose : pas un ticket).
- Voir T-002 et T-003 pour l'historique (prose encore).

## Ouverts

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-001 | bug  | P1   | ouvert | Premier bug \`avec du code\` dans le titre |
| T-003 | feat | P2   | en cours | Fonction en cours de réalisation |

### T-001 — Premier bug (titre court)

Corps du premier bug,
sur deux lignes.

### T-003 — Fonction en cours

Corps du T-003.

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-002 | tech | P3   | fait   | Dette réglée |

---

### T-002 — Dette réglée

Corps du T-002, après le séparateur.
`;

// ── Analyse ──────────────────────────────────────────────────────────────

{
  const tickets = analyserTickets(EXEMPLE);
  verifier("trois lignes de tableau, pas une de plus (la prose ne compte pas)", tickets.length === 3,
    `trouvé ${tickets.length}`);

  const t1 = tickets.find((t) => t.id === "T-001");
  verifier("colonnes lues et rognées", t1?.type === "bug" && t1?.prio === "P1" && t1?.statut === "ouvert");
  verifier("le titre du TABLEAU fait foi, pas celui de la section",
    t1?.titre === "Premier bug `avec du code` dans le titre");
  verifier("le corps vient de la section, lié par l'ID malgré le titre court",
    t1?.corps.includes("sur deux lignes"));
  verifier("le corps s'arrête à la section suivante", !t1?.corps.includes("Corps du T-003"));

  const t2 = tickets.find((t) => t.id === "T-002");
  verifier("un ticket archivé est lu (statut « fait »)", t2?.statut === "fait");
  verifier("sa section située APRÈS le séparateur --- est rattachée",
    t2?.corps.includes("après le séparateur"));

  let refuse = false;
  try {
    analyserTickets("| T-009 | bug | P1 | ouvert | a |\n| T-009 | bug | P1 | ouvert | b |\n");
  } catch {
    refuse = true;
  }
  verifier("un ID en double est refusé, pas fusionné en silence", refuse);
}

// ── Plan ─────────────────────────────────────────────────────────────────

{
  const tickets = analyserTickets(EXEMPLE);

  const depuisRien = planifierMiroir(tickets, []);
  verifier("dépôt vierge : une création par ticket OUVERT, rien pour l'archive",
    depuisRien.length === 2 && depuisRien.every((a) => a.action === "creer"));
  const creation = depuisRien.find((a) => a.id === "T-001");
  verifier("création : titre préfixé par l'ID, labels type + prio",
    creation?.titre === "T-001 — Premier bug `avec du code` dans le titre" &&
      creation?.labels.join(",") === "bug,P1");

  const aJour = planifierMiroir(tickets, [
    { number: 1, title: "T-001 — Premier bug `avec du code` dans le titre", state: "OPEN" },
    { number: 3, title: "T-003 — Fonction en cours de réalisation", state: "OPEN" },
  ]);
  verifier("tout est déjà à jour : aucune action", aJour.length === 0, JSON.stringify(aJour));

  const fermeture = planifierMiroir(tickets, [
    { number: 2, title: "T-002 — Dette réglée", state: "OPEN" },
  ]);
  verifier("ticket archivé + issue ouverte → fermeture, avec le statut",
    fermeture.some((a) => a.action === "fermer" && a.numero === 2 && a.statut === "fait"));

  const reouverture = planifierMiroir(tickets, [
    { number: 1, title: "T-001 — Premier bug `avec du code` dans le titre", state: "CLOSED" },
  ]);
  verifier("ticket ouvert + issue fermée → réouverture",
    reouverture.some((a) => a.action === "rouvrir" && a.numero === 1));

  const retitrage = planifierMiroir(tickets, [
    { number: 1, title: "T-001 — Ancien titre", state: "OPEN" },
  ]);
  verifier("titre changé dans le fichier → l'issue est retitrée",
    retitrage.some((a) => a.action === "retitrer" && a.numero === 1 &&
      a.titre === "T-001 — Premier bug `avec du code` dans le titre"));

  const etrangere = planifierMiroir(tickets, [
    { number: 40, title: "Suggestion : mode sombre", state: "OPEN" },
  ]);
  verifier("une issue du public (sans préfixe T-nnn) n'est jamais touchée",
    !etrangere.some((a) => a.numero === 40));

  let refuse = false;
  try {
    planifierMiroir([{ id: "T-001", type: "bug", prio: "P1", statut: "peut-être", titre: "x", corps: "" }], []);
  } catch {
    refuse = true;
  }
  verifier("un statut inconnu est refusé : le miroir ne devine pas", refuse);
}

// ── Dépôt cible (T-013) ──────────────────────────────────────────────────

{
  verifier("le dépôt cible est nommé, pas déduit du remote local",
    depotCible({}) === "duvamduvam/iaction", depotCible({}));
  verifier("GH_REPO reste prioritaire (dépôt d'essai, fork)",
    depotCible({ GH_REPO: "quelquun/essai" }) === "quelquun/essai");
}

// ── Le vrai fichier : c'est lui que la CI reflétera ──────────────────────

{
  const reel = await fsp.readFile(path.join(__dirname, "..", "docs", "tickets.md"), "utf8");
  const tickets = analyserTickets(reel);
  const connus = new Set(["ouvert", "en cours", "fait", "abandonné"]);

  verifier("docs/tickets.md : au moins les 11 tickets existants", tickets.length >= 11,
    `trouvé ${tickets.length}`);
  verifier("docs/tickets.md : tous les statuts sont connus du miroir",
    tickets.every((t) => connus.has(t.statut)),
    tickets.filter((t) => !connus.has(t.statut)).map((t) => `${t.id}:${t.statut}`).join(" "));
  verifier("docs/tickets.md : chaque ticket a sa section détaillée (la convention l'exige)",
    tickets.every((t) => t.corps.length > 0),
    tickets.filter((t) => t.corps.length === 0).map((t) => t.id).join(" "));
  verifier("docs/tickets.md : types et prios dans les vocabulaires de la convention",
    tickets.every((t) => ["bug", "feat", "tech", "doc"].includes(t.type) && ["P1", "P2", "P3"].includes(t.prio)),
    tickets.filter((t) => !["bug", "feat", "tech", "doc"].includes(t.type) || !["P1", "P2", "P3"].includes(t.prio)).map((t) => t.id).join(" "));
}

console.log(`${reussites} réussite(s), ${echecs} échec(s)`);
process.exit(echecs === 0 ? 0 : 1);
