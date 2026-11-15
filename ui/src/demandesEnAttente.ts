/*
 * Demandes en attente de l'utilisateur (T-181) — la logique PURE de la file
 * des questions d'agent et des demandes de permission.
 *
 * Une demande vit tant que le TOUR qui l'a posée attend côté sidecar : elle ne
 * disparaît ni au changement de projet, ni au vidage d'une conversation (la
 * vider ne tue pas le tour). Chaque élément garde son projet et sa
 * conversation ; la modale ne montre que les demandes du projet COURANT, les
 * autres attendent dans la section « En attente de vous » du panneau latéral.
 *
 * Feuille : un seul import, `questionsAgent`.
 */

import {
  isAskQuestionTool,
  parseAskQuestions,
  permissionTitle,
  type PermissionRequestItem,
} from "./questionsAgent";

/** Clé stable d'une demande (un tour peut en poser plusieurs, une par permissionId). */
export function cleDemande(item: PermissionRequestItem): string {
  return `${item.targetId}:${item.permissionId}`;
}

/** Même projet ? `undefined` et `null` (aucun projet) sont une seule et même valeur. */
function memeProjet(item: PermissionRequestItem, projectId: string | null): boolean {
  return (item.projectId ?? null) === (projectId ?? null);
}

/** Sortie de file : le tour (identifié par son `targetId`) est terminé, interrompu ou en erreur. */
export function sansDemandesDuTour(file: readonly PermissionRequestItem[], targetId: string): PermissionRequestItem[] {
  return file.filter((p) => p.targetId !== targetId);
}

/** Sortie de file : le projet n'existe plus, ses tours n'ont plus personne à qui parler. */
export function sansDemandesDuProjet(
  file: readonly PermissionRequestItem[],
  projectId: string | null,
): PermissionRequestItem[] {
  return file.filter((p) => !memeProjet(p, projectId));
}

/** Sortie de file : une demande précise a reçu sa réponse. */
export function sansDemande(file: readonly PermissionRequestItem[], cible: PermissionRequestItem): PermissionRequestItem[] {
  const cle = cleDemande(cible);
  return file.filter((p) => cleDemande(p) !== cle);
}

/**
 * Demande à montrer dans la modale : UNIQUEMENT une demande du projet courant.
 * Priorité à celle que l'utilisateur vient de rouvrir (`cleFocale`), puis à la
 * première non mise de côté ; à défaut, la première mise de côté (la modale
 * reste montée, repliée, pour garder les choix déjà cochés).
 */
export function demandeCourante(
  file: readonly PermissionRequestItem[],
  projectId: string | null,
  clesDeCote: readonly string[],
  cleFocale: string | null,
): { item: PermissionRequestItem; replie: boolean } | null {
  const duProjet = file.filter((p) => memeProjet(p, projectId));
  if (duProjet.length === 0) return null;
  const focale = cleFocale ? duProjet.find((p) => cleDemande(p) === cleFocale) : undefined;
  if (focale) return { item: focale, replie: false };
  const aTraiter = duProjet.find((p) => !clesDeCote.includes(cleDemande(p)));
  if (aTraiter) return { item: aTraiter, replie: false };
  return { item: duProjet[0], replie: true };
}

/** Nombre d'autres demandes du même projet derrière la courante (badge « +n » de la modale). */
export function nombreAutresDuProjet(
  file: readonly PermissionRequestItem[],
  projectId: string | null,
  courante: PermissionRequestItem,
): number {
  return file.filter((p) => memeProjet(p, projectId) && cleDemande(p) !== cleDemande(courante)).length;
}

/** Titre court d'une demande : le texte de la première question, ou le titre de permission. */
export function titreCourt(item: PermissionRequestItem, max = 60): string {
  let titre = permissionTitle(item);
  if (isAskQuestionTool(item.toolName)) {
    const premiere = parseAskQuestions(item.toolInput)[0];
    if (premiere) titre = premiere.header || premiere.question;
  }
  titre = titre.replace(/\s+/g, " ").trim();
  return titre.length > max ? `${titre.slice(0, max - 1)}…` : titre;
}

export interface LigneAttente {
  cle: string;
  type: "question" | "permission";
  titre: string;
  projet: string;
  conversation: string;
  item: PermissionRequestItem;
}

/** Une ligne par demande, tous projets confondus, dans l'ordre d'arrivée. */
export function lignesEnAttente(
  file: readonly PermissionRequestItem[],
  nomProjet: (projectId: string | null) => string | null,
  titreConversation: (projectId: string | null, convId: string | null) => string | null,
): LigneAttente[] {
  return file.map((item) => {
    const projectId = item.projectId ?? null;
    const convId = item.convId ?? null;
    return {
      cle: cleDemande(item),
      type: isAskQuestionTool(item.toolName) ? "question" : "permission",
      titre: titreCourt(item),
      projet: nomProjet(projectId) ?? "Projet inconnu",
      conversation: titreConversation(projectId, convId) ?? "Conversation inconnue",
      item,
    };
  });
}

/** Libellé de l'en-tête de section. */
export function titreSectionAttente(n: number): string {
  return `En attente de vous (${n})`;
}

/** Libellé accessible/infobulle d'une ligne. */
export function libelleLigne(l: LigneAttente): string {
  const genre = l.type === "question" ? "Question" : "Permission";
  return `${genre} — ${l.titre} · ${l.projet} · ${l.conversation}`;
}
