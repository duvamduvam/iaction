/*
 * Fermeture en LOT des onglets (T-109) — la décision, pas le rendu.
 *
 * ── Pourquoi un module à part ────────────────────────────────────────────
 * La barre d'onglets vit dans deux pages de ~2 800 lignes (AgentPage.tsx,
 * ChatPage.tsx) que le cliquet de taille interdit de faire grossir, et le
 * projet n'a pas d'environnement DOM en test : ce qui n'est pas extrait
 * n'est pas prouvé. La question posée par le menu contextuel — « ce clic
 * ferme QUOI, et qu'est-ce qui survit, et pourquoi ? » — est purement
 * arithmétique. Elle se répond donc ici, sans React, et se teste.
 *
 * ── La règle qui gouverne tout : un lot ne force jamais la main ──────────
 * Deux onglets refusent d'être fermés en masse :
 *   - une conversation dont le tour STREAME (la fermer perdrait le tour de
 *     vue — c'est déjà le refus du « × », voir closeConversationTab) ;
 *   - un fichier NON ENREGISTRÉ (fermer 5 onglets ne doit pas déclencher 5
 *     confirmations natives d'affilée, ni pire, avaler 5 éditions).
 * Ces onglets ne sont pas « oubliés » : ils sortent dans `conserves` avec
 * leur raison, que la page affiche dans son bandeau (`agent-tabs__notice`).
 * Un onglet qui survit sans que rien ne le dise serait un échec muet — la
 * seule chose que ce projet ne se permet pas.
 *
 * Le « × » d'un onglet et l'item « Fermer » gardent, eux, le chemin unitaire
 * existant : confirmation pour un fichier modifié, refus motivé pour un tour
 * en cours. Ce module ne s'occupe QUE des lots.
 *
 * ── Familles ────────────────────────────────────────────────────────────
 * La barre mélange conversations et fichiers ouverts. « Les autres » ou « à
 * droite » à cheval sur les deux n'aurait aucun sens : chaque action reste
 * cantonnée à la famille de l'onglet cliqué. Seul « Fermer tous les
 * fichiers » traverse, et uniquement dans ce sens (il n'existe pas de
 * « fermer toutes les conversations » depuis un onglet de fichier : une
 * conversation fermée par mégarde depuis un autre contexte se rouvre, mais
 * l'ordre reste celui de la famille qu'on regarde).
 */

export type FamilleOnglet = "conversation" | "fichier";

/** Pourquoi un onglet refuse d'être fermé en lot. `null` = rien ne s'y oppose. */
export type ProtectionOnglet = "tour-en-cours" | "non-enregistre";

export interface OngletDeBarre {
  /** Identifiant de session pour une conversation, chemin absolu pour un fichier. */
  readonly id: string;
  readonly famille: FamilleOnglet;
  readonly protection: ProtectionOnglet | null;
}

export type ActionLot = "les-autres" | "a-droite" | "toute-la-famille" | "enregistres" | "tous-les-fichiers";

/** `cet-onglet` n'est pas un lot : la page le route vers sa fermeture unitaire. */
export type CleItemMenu = ActionLot | "cet-onglet";

export interface ItemMenuOnglet {
  cle: CleItemMenu;
  libelle: string;
  /** `false` = item grisé. Les items ne DISPARAISSENT pas selon l'état : leur
   *  position ne doit pas bouger d'un clic droit à l'autre. */
  actif: boolean;
  /** Un trait de séparation précède cet item. */
  separateurAvant?: boolean;
}

export interface OngletConserve {
  id: string;
  raison: ProtectionOnglet;
}

export interface ResultatLot {
  aFermer: string[];
  conserves: OngletConserve[];
}

function memeFamille(onglets: readonly OngletDeBarre[], famille: FamilleOnglet): OngletDeBarre[] {
  return onglets.filter((o) => o.famille === famille);
}

/**
 * Les onglets VISÉS par une action, protections non appliquées. Un `ancre`
 * absent de la liste ne vise rien : le menu s'est ouvert sur un onglet qui
 * vient de disparaître.
 */
export function ciblesLot(onglets: readonly OngletDeBarre[], ancre: string, action: ActionLot): OngletDeBarre[] {
  const cible = onglets.find((o) => o.id === ancre);
  if (!cible) return [];
  const famille = memeFamille(onglets, cible.famille);
  switch (action) {
    case "les-autres":
      return famille.filter((o) => o.id !== ancre);
    case "a-droite": {
      const position = famille.findIndex((o) => o.id === ancre);
      return famille.slice(position + 1);
    }
    case "toute-la-famille":
      return famille;
    case "enregistres":
      // Tous les fichiers ouverts qui n'ont rien à perdre, y compris l'onglet
      // cliqué (même geste que « Close Saved Editors » de VS Code).
      return memeFamille(onglets, "fichier").filter((o) => o.protection === null);
    case "tous-les-fichiers":
      return memeFamille(onglets, "fichier");
  }
}

/** Ce que l'action ferme vraiment, et ce qu'elle laisse en place — avec la raison. */
export function resoudreLot(onglets: readonly OngletDeBarre[], ancre: string, action: ActionLot): ResultatLot {
  const cibles = ciblesLot(onglets, ancre, action);
  return {
    aFermer: cibles.filter((o) => o.protection === null).map((o) => o.id),
    conserves: cibles
      .filter((o): o is OngletDeBarre & { protection: ProtectionOnglet } => o.protection !== null)
      .map((o) => ({ id: o.id, raison: o.protection })),
  };
}

function pluriel(n: number, singulier: string, plurielMot = `${singulier}s`): string {
  return `${n} ${n > 1 ? plurielMot : singulier}`;
}

/**
 * Le bandeau à afficher après un lot, ou `null` quand tout est parti comme
 * demandé : ce qui s'est passé se voit alors à l'écran, un message de plus ne
 * dirait rien. On ne parle que pour signaler ce qui a SURVÉCU.
 */
export function messageLot(resultat: ResultatLot): string | null {
  if (resultat.conserves.length === 0) return null;
  const tours = resultat.conserves.filter((c) => c.raison === "tour-en-cours").length;
  const modifies = resultat.conserves.filter((c) => c.raison === "non-enregistre").length;
  const raisons: string[] = [];
  if (tours > 0) raisons.push(`${pluriel(tours, "tour")} en cours`);
  if (modifies > 0) raisons.push(`${pluriel(modifies, "fichier")} non ${modifies > 1 ? "enregistrés" : "enregistré"}`);
  const detail = `${pluriel(resultat.conserves.length, "conservé")} : ${raisons.join(", ")}.`;
  if (resultat.aFermer.length === 0) return `Aucun onglet fermé — ${detail}`;
  return `${pluriel(resultat.aFermer.length, "onglet fermé", "onglets fermés")} · ${detail}`;
}

/**
 * Les items du menu contextuel pour l'onglet cliqué. Un item sans aucune
 * cible fermable est présent mais grisé (`actif: false`).
 */
export function itemsMenuOnglets(onglets: readonly OngletDeBarre[], ancre: string): ItemMenuOnglet[] {
  const cible = onglets.find((o) => o.id === ancre);
  if (!cible) return [];
  const possible = (action: ActionLot) => resoudreLot(onglets, ancre, action).aFermer.length > 0;
  const items: ItemMenuOnglet[] = [
    // Un tour en cours interdit la fermeture ; un fichier modifié ne
    // l'interdit pas — il demandera confirmation, comme le « × ».
    { cle: "cet-onglet", libelle: "Fermer", actif: cible.protection !== "tour-en-cours" },
  ];
  if (cible.famille === "conversation") {
    items.push(
      { cle: "les-autres", libelle: "Fermer les autres conversations", actif: possible("les-autres") },
      { cle: "a-droite", libelle: "Fermer les conversations à droite", actif: possible("a-droite") },
      {
        cle: "toute-la-famille",
        libelle: "Fermer toutes les conversations",
        actif: possible("toute-la-famille"),
        separateurAvant: true,
      },
    );
    // Proposé seulement quand la page a des onglets de fichiers (elle n'en a
    // que sur Projets, et seulement si l'utilisateur en a ouvert).
    if (onglets.some((o) => o.famille === "fichier")) {
      items.push({ cle: "tous-les-fichiers", libelle: "Fermer tous les fichiers", actif: possible("tous-les-fichiers") });
    }
    return items;
  }
  items.push(
    { cle: "les-autres", libelle: "Fermer les autres fichiers", actif: possible("les-autres") },
    { cle: "a-droite", libelle: "Fermer les fichiers à droite", actif: possible("a-droite") },
    { cle: "enregistres", libelle: "Fermer les fichiers enregistrés", actif: possible("enregistres") },
    {
      cle: "toute-la-famille",
      libelle: "Fermer tous les fichiers",
      actif: possible("toute-la-famille"),
      separateurAvant: true,
    },
  );
  return items;
}

/**
 * L'onglet à activer quand la fermeture emporte l'onglet actif : le plus
 * proche VOISIN DE GAUCHE encore ouvert (règle unitaire d'origine, étendue au
 * lot — il faut sauter les onglets fermés du même coup), à défaut le premier
 * survivant, `null` si la famille est vidée.
 *
 * `ouverts` est l'ordre AVANT fermeture ; `fermes` les identifiants qui
 * partent.
 */
export function ongletApresFermeture(
  ouverts: readonly string[],
  actif: string,
  fermes: readonly string[],
): string | null {
  const partants = new Set(fermes);
  const restants = ouverts.filter((id) => !partants.has(id));
  if (restants.length === 0) return null;
  if (!partants.has(actif)) return actif;
  const position = ouverts.indexOf(actif);
  for (let i = position - 1; i >= 0; i--) {
    const candidat = ouverts[i];
    if (!partants.has(candidat)) return candidat;
  }
  return restants[0];
}
