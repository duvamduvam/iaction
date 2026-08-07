/**
 * Backlog de tickets — méthode TK1 (`tickets.list`), voir docs/protocol.md,
 * section « Méthode TK1 — backlog de tickets (lecture) ».
 *
 * POURQUOI : le backlog est un fichier Markdown écrit À LA MAIN. Le panneau
 * « Tickets » de la page Système ne fait que l'AFFICHER — aucune réécriture :
 * le fichier reste la source de vérité, éditée dans l'éditeur. Une méthode
 * d'écriture aurait imposé de regénérer le Markdown, donc de figer sa mise en
 * forme ; on préfère un parseur tolérant et un fichier libre. Seule exception,
 * le dépôt du gabarit initial quand aucun fichier n'existe (voir
 * `deposerGabaritSiAbsent`).
 *
 * OÙ : `<config>/tickets.md`, au même niveau que `config.json`, `logs/`,
 * `agents/` et `taches/`. Ce carnet n'appartient ni à un projet ni au dépôt
 * iaction — il suit l'utilisateur, comme le reste de sa configuration.
 * (Historique : il pointait vers le `docs/tickets.md` du dépôt, résolu depuis
 * le `dist/` du sidecar. Une application installée allait donc chercher le
 * backlog du dépôt qui l'avait produite, à un chemin inexistant chez
 * l'utilisateur — de la plomberie de développement qui fuyait dans le produit.)
 *
 * Le parseur est TOLÉRANT par construction : le fichier dérivera (c'est un
 * humain qui l'écrit). Une ligne difforme est ignorée, jamais une erreur ; une
 * ligne de tableau sans section détaillée, ou l'inverse, remonte quand même
 * avec ce qu'on a. Parseur ligne à ligne, aucune dépendance Markdown.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { EngineEmitter } from "./engine.js";
import { globalConfigRoot } from "./appPaths.js";
import * as journal from "./journal.js";

/** Un ticket du backlog, tel qu'il part vers l'UI (voir docs/protocol.md § TK1). */
export interface Ticket {
  /** `T-001` — identifiant normalisé en majuscules. */
  id: string;
  /** `bug` · `feat` · `tech` · `doc` (minuscules), `""` si le fichier ne le dit pas. */
  type: string;
  /** `P1` · `P2` · `P3` (majuscules), `""` si absent. */
  prio: string;
  /** `ouvert` · `en cours` · `fait` · `abandonné` (minuscules), `""` si absent. */
  statut: string;
  titre: string;
  /** Date de création `AAAA-MM-JJ` lue dans la section détaillée, `""` si absente. */
  cree: string;
  /** Markdown de la section détaillée, TEL QUEL (l'UI le rend). `""` si pas de section. */
  corps: string;
  /** `true` si le ticket est sous le titre « Archivés ». */
  archive: boolean;
}

// ---------------------------------------------------------------------------
// Résolution du fichier
// ---------------------------------------------------------------------------

/**
 * Chemin du backlog : `IACTION_TICKETS_MD` s'il est posé, sinon
 * `<config>/tickets.md` — **au même niveau que `config.json`, `logs/`,
 * `agents/` et `taches/`**.
 *
 * Il a longtemps été résolu vers le `docs/tickets.md` du DÉPÔT iaction, à
 * partir du `dist/` du sidecar. C'était de la plomberie de développement qui
 * fuyait dans le produit : une application installée allait chercher le
 * backlog du dépôt qui l'avait produite, à un chemin qui n'existe pas chez
 * l'utilisateur (`%LOCALAPPDATA%\docs\tickets.md`). Le panneau « Tickets »
 * n'appartient à aucun projet et n'est pas propre au dépôt : c'est un carnet
 * de bord de l'utilisateur, il vit donc avec sa configuration.
 *
 * Le développement du projet garde son backlog versionné en pointant la
 * variable d'environnement dessus (voir `scripts/dev.sh`).
 */
export function resolveTicketsPath(): string {
  const override = process.env.IACTION_TICKETS_MD;
  if (typeof override === "string" && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(globalConfigRoot(), "tickets.md");
}

/**
 * Gabarit déposé au premier accès, quand aucun backlog n'existe encore.
 *
 * Écrire ici est la SEULE écriture du module, et elle n'a lieu qu'une fois :
 * le fichier reste ensuite la propriété de celui qui l'édite (voir l'en-tête —
 * pas de réécriture, pas de mise en forme imposée). Sans ce dépôt initial, le
 * panneau afficherait « backlog introuvable » à un utilisateur qui n'a aucun
 * moyen de deviner où poser le fichier ni sous quelle forme.
 */
const GABARIT_BACKLOG = `# Tickets

> Votre carnet de bord : corrections à venir et idées à ne pas perdre.
> Fichier libre, édité à la main. Un ticket = une ligne du tableau, et si
> besoin une section détaillée plus bas.

## Convention

- **ID** : \`T-001\`, incrémental, jamais réutilisé.
- **Type** : \`bug\` · \`feat\` · \`tech\` · \`doc\`.
- **Prio** : \`P1\` (à faire ensuite) · \`P2\` (important) · \`P3\` (un jour).
- **Statut** : \`ouvert\` → \`en cours\` → \`fait\`, ou \`abandonné\`.

## Ouverts

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
`;

/**
 * Crée le backlog s'il n'existe pas. Best-effort : un échec (droits, disque
 * plein) laisse simplement la lecture échouer ensuite, avec son message.
 */
async function deposerGabaritSiAbsent(chemin: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(chemin), { recursive: true });
    // `wx` : création EXCLUSIVE — deux sidecars lancés en même temps ne
    // peuvent pas s'écraser l'un l'autre, et un fichier existant n'est jamais
    // touché.
    await fsp.writeFile(chemin, GABARIT_BACKLOG, { encoding: "utf8", flag: "wx" });
    journal.info("sidecar", "backlog de tickets créé", { fields: { chemin } });
  } catch {
    // Existe déjà, ou impossible à créer : les deux cas sont traités par la
    // lecture qui suit.
  }
}

// ---------------------------------------------------------------------------
// Parseur ligne à ligne
// ---------------------------------------------------------------------------

/** Identifiant de ticket : `T-` suivi de chiffres. Le reste est ignoré. */
const ID_RE = /^T-\d+$/i;

/** Titre de niveau 2 : `## Ouverts`, `## Archivés`… (`###` n'y matche pas). */
const HEADING2_RE = /^##[ \t]+(.*)$/;

/** Titre de section détaillée : `### T-001 — Titre` (tiret cadratin, demi-cadratin ou simple). */
const HEADING3_RE = /^###[ \t]+(T-\d+)[ \t]*(?:[—–-]+[ \t]*(.*))?$/i;

/** Fin d'une section détaillée : tout titre de niveau 1 à 3 (un `####` reste dans le corps). */
const FIN_SECTION_RE = /^#{1,3}[ \t]/;

function ticketVide(id: string, archive: boolean): Ticket {
  return { id, type: "", prio: "", statut: "", titre: "", cree: "", corps: "", archive };
}

/**
 * Une ligne de tableau `| T-001 | feat | P3 | ouvert | Titre |`.
 * Rend `null` pour la ligne d'en-tête, la ligne de séparation, et toute ligne
 * dont la première cellule n'est pas un identifiant — c'est ce qui rend le
 * parseur insensible aux tableaux mal alignés ou incomplets.
 */
function parseLigneTableau(line: string): Omit<Ticket, "corps" | "cree" | "archive"> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }
  const cells = trimmed.split("|").map((c) => c.trim());
  // `"|a|b|".split("|")` → `["", "a", "b", ""]` : on retire les bords vides.
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  if (cells.length < 5) {
    return null;
  }
  const id = cells[0].toUpperCase();
  if (!ID_RE.test(id)) {
    return null;
  }
  return {
    id,
    type: cells[1].toLowerCase(),
    prio: cells[2].toUpperCase(),
    statut: cells[3].toLowerCase(),
    titre: cells[4],
  };
}

/**
 * Valeur d'un champ `**Nom** valeur` de la ligne d'en-tête d'une section
 * détaillée (`**Type** feat · **Prio** P3 · **Statut** en cours · **Créé** …`).
 * S'arrête au séparateur `·`, à une étoile ou à la fin de ligne — un statut en
 * deux mots (« en cours ») est donc rendu entier.
 */
function champMeta(corps: string, nom: string): string {
  const re = new RegExp(`\\*\\*${nom}\\*\\*[ \\t]*:?[ \\t]*([^*·\\n]+)`, "i");
  const m = re.exec(corps);
  return m ? m[1].trim() : "";
}

/** Retire les lignes vides de tête et de queue sans toucher à l'indentation interne. */
function trimLignes(lines: string[]): string {
  let debut = 0;
  let fin = lines.length;
  while (debut < fin && lines[debut].trim() === "") debut += 1;
  while (fin > debut && lines[fin - 1].trim() === "") fin -= 1;
  return lines.slice(debut, fin).join("\n");
}

/**
 * Markdown du backlog → tickets. Croise le tableau (ligne = index) et les
 * sections détaillées (corps + métadonnées) ; l'un des deux suffit à faire
 * exister un ticket. Le tableau est PRIORITAIRE sur la ligne d'en-tête de la
 * section pour type/prio/statut/titre : c'est lui qu'on relit d'un coup d'œil,
 * donc lui qu'on tient à jour. La section ne comble que les trous.
 *
 * `archive` vient du dernier titre de niveau 2 rencontré (« Archivés » → vrai).
 */
export function parseTickets(markdown: string): Ticket[] {
  const lines = markdown.split(/\r?\n/);
  const ordre: string[] = [];
  const parId = new Map<string, Ticket>();

  let archive = false;
  /** Section détaillée en cours de collecte, `null` hors section. */
  let courant: { id: string; titre: string; lignes: string[] } | null = null;

  function ouSCreer(id: string): Ticket {
    let ticket = parId.get(id);
    if (!ticket) {
      ticket = ticketVide(id, archive);
      parId.set(id, ticket);
      ordre.push(id);
    }
    return ticket;
  }

  /** Clôt la section en cours : son corps et ses métadonnées rejoignent le ticket. */
  function cloreSection(): void {
    if (!courant) {
      return;
    }
    const corps = trimLignes(courant.lignes);
    const ticket = ouSCreer(courant.id);
    ticket.corps = corps;
    if (!ticket.titre) ticket.titre = courant.titre;
    if (!ticket.type) ticket.type = champMeta(corps, "Type").toLowerCase();
    if (!ticket.prio) ticket.prio = champMeta(corps, "Prio").toUpperCase();
    if (!ticket.statut) ticket.statut = champMeta(corps, "Statut").toLowerCase();
    if (!ticket.cree) ticket.cree = champMeta(corps, "Créé");
    courant = null;
  }

  for (const line of lines) {
    // Une section détaillée s'arrête au titre suivant (niveau 1 à 3).
    if (courant && FIN_SECTION_RE.test(line)) {
      cloreSection();
    }

    const h2 = HEADING2_RE.exec(line);
    if (h2) {
      // Sensible au seul mot « archiv » : « Archivés », « Archives », « archivé ».
      archive = /archiv/i.test(h2[1]);
      continue;
    }

    const h3 = HEADING3_RE.exec(line);
    if (h3) {
      courant = { id: h3[1].toUpperCase(), titre: (h3[2] ?? "").trim(), lignes: [] };
      // Le ticket existe dès son titre : une section sans ligne de tableau
      // remonte quand même, et garde sa place dans l'ordre du fichier.
      ouSCreer(courant.id);
      continue;
    }

    if (courant) {
      courant.lignes.push(line);
      continue;
    }

    // Hors section détaillée seulement : un tableau écrit DANS le corps d'un
    // ticket ne doit pas être pris pour une entrée du backlog.
    const ligne = parseLigneTableau(line);
    if (ligne) {
      const ticket = ouSCreer(ligne.id);
      ticket.archive = archive;
      if (ligne.type) ticket.type = ligne.type;
      if (ligne.prio) ticket.prio = ligne.prio;
      if (ligne.statut) ticket.statut = ligne.statut;
      if (ligne.titre) ticket.titre = ligne.titre;
    }
  }

  cloreSection();

  return ordre.map((id) => parId.get(id)!).filter((t): t is Ticket => t !== undefined);
}

// ---------------------------------------------------------------------------
// tickets.list
// ---------------------------------------------------------------------------

/**
 * Lecture seule du backlog. Ne rejette QUE si le parseur explose (il ne le
 * fait pas) : fichier absent ou illisible → `{tickets: [], disponible: false}`,
 * l'UI le dit sobrement au lieu d'afficher une erreur technique.
 */
export async function handleTicketsList(
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const chemin = resolveTicketsPath();
  await deposerGabaritSiAbsent(chemin);

  let markdown: string;
  try {
    markdown = await fsp.readFile(chemin, "utf8");
  } catch (err) {
    // ABSENCE ≠ ANOMALIE. Ce backlog appartient au dépôt iaction : dans une
    // application INSTALLÉE il n'existe pas, et n'a aucune raison d'exister —
    // le chemin résolu y pointe hors de tout dépôt. Un `warn` à chaque
    // démarrage donnait donc l'alerte pour un cas parfaitement nominal
    // (constaté sur le poste Windows, 2026-08-07).
    //
    // On garde en revanche le `warn` pour un fichier PRÉSENT mais illisible
    // (droits, encodage) : là, quelque chose est réellement cassé.
    const absent = (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    journal[absent ? "debug" : "warn"]("sidecar", "backlog de tickets introuvable", {
      reqId: id,
      fields: { chemin, erreur: err instanceof Error ? err.message : String(err) },
    });
    emitter.done(id, { tickets: [], disponible: false, chemin });
    return;
  }

  let tickets: Ticket[] = [];
  try {
    tickets = parseTickets(markdown);
  } catch (err) {
    // Filet : un backlog illisible ne vaut pas mieux qu'un backlog absent,
    // mais il ne doit surtout pas remonter en erreur de protocole.
    journal.warn("sidecar", "backlog de tickets illisible", {
      reqId: id,
      fields: { chemin, erreur: err instanceof Error ? err.message : String(err) },
    });
  }

  emitter.done(id, { tickets, disponible: true, chemin });
}
