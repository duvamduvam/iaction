/*
 * Comptes Claude côté interface — « Claude Perso » / « Claude Teams »
 * (docs/spec-deux-comptes.md).
 *
 * Tout ce que l'interface sait des deux comptes tient ici : la liste rendue par
 * `claude.comptes`, les options de la liste « Moteur », et la RÉSOLUTION du
 * compte d'une session (choix explicite, sinon défaut du projet, sinon perso).
 * Les règles sont pures et exportées pour être testées hors webview.
 *
 * Le moteur reste modélisé tel quel (`providerId: null` = Claude) : le compte
 * est un champ de plus, jamais un faux fournisseur.
 *
 * Invisible sans second compte (règle 3) : tant que `claude.comptes` ne rend pas
 * `teams`, les options, le libellé « Claude (abonnement) » et l'encart sont ceux
 * d'avant. Jamais de bascule automatique : rien ici ne change de compte à la
 * place de l'utilisateur.
 */
import { useEffect, useState } from "react";
import { request, subscribeReady } from "./sidecar";
import { logWarn } from "./journal";

export type CompteClaude = "perso" | "teams";

export interface CompteDecrit {
  id: CompteClaude;
  label: string;
  connecte: boolean;
}

/** Libellé de Claude tant qu'il n'y a qu'un compte : celui d'aujourd'hui, à l'identique. */
export const LIBELLE_CLAUDE_UNIQUE = "Claude (abonnement)";

/** Valeur de l'option « Claude Teams » dans une liste Moteur (« Claude Perso » garde la valeur historique de Claude). */
export const VALEUR_MOTEUR_TEAMS = "@claude:teams";

export function estCompteClaude(valeur: unknown): valeur is CompteClaude {
  return valeur === "perso" || valeur === "teams";
}

/** Compte explicitement choisi d'un moteur persisté, ou `null` (champ absent ou illisible = pas de choix). */
export function compteExplicite(engine: object): CompteClaude | null {
  const brut = (engine as { compte?: unknown }).compte;
  return estCompteClaude(brut) ? brut : null;
}

/**
 * Compte par défaut déclaré par un projet (`compteClaude` de la config du poste),
 * ou `null`. Une valeur invalide est ignorée ICI (le `warn` est au chargement,
 * voir `projectAdmin.ts`) : on ne devine pas un compte à partir d'une faute de frappe.
 */
export function defautDeProjet(projet: { compteClaude?: unknown } | null | undefined): CompteClaude | null {
  return estCompteClaude(projet?.compteClaude) ? projet.compteClaude : null;
}

/** Lecture tolérante de la réponse de `claude.comptes` : ce qui n'est pas reconnu est ignoré. */
export function parseComptes(data: Record<string, unknown>): CompteDecrit[] {
  if (!Array.isArray(data.comptes)) return [];
  const out: CompteDecrit[] = [];
  for (const brut of data.comptes) {
    if (typeof brut !== "object" || brut === null) continue;
    const c = brut as Record<string, unknown>;
    if (!estCompteClaude(c.id)) continue;
    out.push({ id: c.id, label: typeof c.label === "string" ? c.label : c.id, connecte: c.connecte !== false });
  }
  return out;
}

/** Le compte Teams est-il listé (identifiants posés) ? Sinon la fonction est invisible. */
export function secondCompteDispo(comptes: readonly CompteDecrit[] | null): boolean {
  return comptes?.some((c) => c.id === "teams") ?? false;
}

/**
 * Compte d'une session : choix explicite de la session, sinon défaut du projet,
 * sinon `perso`.
 *
 * - Défaut `teams` et AUCUN compte Teams listé (poste sans second compte) : retour
 *   à `perso`, signalé (`repli: true`, que l'appelant journalise).
 * - Défaut `teams` et compte listé mais déconnecté : PAS de repli — le tour part
 *   sur `teams` et le sidecar le refuse avec la commande de connexion (règle 2 :
 *   le travail d'une organisation ne glisse pas seul sur le compte personnel).
 * - Liste inconnue (`null` : pas encore reçue, ou appel en échec) : un échec ne
 *   vaut jamais « aucun compte ». Le compte reste `teams` (provisoire) et
 *   `attente: true` dit à l'envoi d'attendre la réponse (`compteAuDepart`).
 * - Un choix EXPLICITE n'est jamais réécrit ni retardé.
 */
export function resoudreCompteSession(
  explicite: CompteClaude | null | undefined,
  defautProjet: CompteClaude | null | undefined,
  comptes: readonly CompteDecrit[] | null,
): { compte: CompteClaude; repli: boolean; attente: boolean } {
  if (explicite) return { compte: explicite, repli: false, attente: false };
  if (defautProjet === "teams") {
    if (comptes === null) return { compte: "teams", repli: false, attente: true };
    return secondCompteDispo(comptes)
      ? { compte: "teams", repli: false, attente: false }
      : { compte: "perso", repli: true, attente: false };
  }
  return { compte: "perso", repli: false, attente: false };
}

/**
 * Compte à persister quand l'utilisateur CHOISIT « Claude Perso » ou « Claude
 * Teams » : choisir perso quand le défaut résolu est déjà perso n'est pas un
 * choix à figer (revenir d'un moteur neutre ne doit pas écrire `perso` — la
 * session continue de suivre le défaut de son projet). Teams est toujours figé.
 */
export function compteAPersister(choisi: CompteClaude, defautResolu: CompteClaude): CompteClaude | null {
  return choisi === "perso" && defautResolu === "perso" ? null : choisi;
}

/** Valeur d'une liste Moteur → moteur + compte. `compte: undefined` = valeur d'un fournisseur neutre (compte inchangé). */
export function lireChoixMoteur(valeur: string): { providerId: string | null; compte: CompteClaude | undefined } {
  if (valeur === VALEUR_MOTEUR_TEAMS) return { providerId: null, compte: "teams" };
  if (valeur === "") return { providerId: null, compte: "perso" };
  return { providerId: valeur, compte: undefined };
}

/**
 * Le routage Auto ne connaît que `perso` : Auto n'est PAS proposé quand le compte
 * effectif est autre, et un modèle Auto devient le modèle Claude par défaut. Hors
 * ce cas, changer de compte ne change pas le modèle.
 */
export function autoPropose(compte: CompteClaude): boolean {
  return compte === "perso";
}

export function modeleCompatibleCompte(model: string, compte: CompteClaude, idAuto: string, modeleClaudeDefaut: string): string {
  return model === idAuto && !autoPropose(compte) ? modeleClaudeDefaut : model;
}

/** Pose (ou retire) le choix de compte d'UNE session d'un chat ; les autres restent intactes. */
export function avecCompteChat<S extends { id: string; compte?: CompteClaude }>(
  sessions: S[],
  id: string,
  compte: CompteClaude | null,
): S[] {
  return sessions.map((s) => {
    if (s.id !== id) return s;
    const { compte: _ancien, ...reste } = s;
    return (compte ? { ...reste, compte } : reste) as S;
  });
}

/** Comptes à sonder : `perso` toujours, `teams` s'il est listé ET connecté (un compte déconnecté échouerait à chaque battement). */
export function comptesASonder(comptes: readonly CompteDecrit[] | null): CompteClaude[] {
  return comptes?.some((c) => c.id === "teams" && c.connecte) ? ["perso", "teams"] : ["perso"];
}

export interface OptionMoteurClaude {
  value: string;
  label: string;
}

/**
 * Options « Claude » d'une liste Moteur. Sans second compte : l'unique option
 * d'aujourd'hui. Avec : « Claude Perso » et « Claude Teams », ce dernier
 * signalé s'il est déconnecté (il reste sélectionnable, le tour dira quoi faire).
 * `valeurPerso` est la valeur historique de Claude dans la liste appelante
 * (`""` pour l'agent, l'id du pseudo-fournisseur pour le chat).
 */
export function optionsMoteurClaude(
  comptes: readonly CompteDecrit[] | null,
  valeurPerso: string,
  compteActif: CompteClaude = "perso",
): OptionMoteurClaude[] {
  // Un compte Teams déjà choisi reste affiché même si ses identifiants ont disparu depuis.
  if (!secondCompteDispo(comptes) && compteActif !== "teams") return [{ value: valeurPerso, label: LIBELLE_CLAUDE_UNIQUE }];
  const teams = comptes?.find((c) => c.id === "teams");
  const suffixe = teams ? (teams.connecte ? "" : " (déconnecté)") : comptes === null ? "" : " (indisponible)";
  return [
    { value: valeurPerso, label: "Claude Perso" },
    { value: VALEUR_MOTEUR_TEAMS, label: `Claude Teams${suffixe}` },
  ];
}

/** Nom affiché d'un compte (encart, listes de sessions quand il y en a deux). */
export function libelleCompte(compte: CompteClaude): string {
  return compte === "teams" ? "Claude Teams" : "Claude Perso";
}

/** Pour le journal : le compte par défaut d'un projet est retombé sur perso. */
export function journaliserRepliCompte(projetId: string | null): void {
  logWarn("claude", "compte par défaut du projet indisponible (aucun second compte) : retour à Claude Perso", {
    fields: { projet: projetId, compteDemande: "teams" },
  });
}

/**
 * `claude.comptes`. `null` = l'appel a ÉCHOUÉ : ce n'est pas « aucun second
 * compte », l'appelant garde sa dernière liste connue (docs/spec-deux-comptes.md).
 */
export async function chargerComptes(): Promise<CompteDecrit[] | null> {
  try {
    const { done } = request("claude.comptes", {});
    const data = await done;
    if (!Array.isArray(data.comptes)) throw new Error("réponse sans liste de comptes");
    return parseComptes(data);
  } catch (err) {
    logWarn("claude", "claude.comptes en échec : la dernière liste connue est conservée", {
      fields: { erreur: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

/* ---------- Partage entre pages : une seule liste, rafraîchie à l'annonce du sidecar ---------- */

/** Dernière liste CONNUE ; `null` tant qu'aucune réponse n'est arrivée. Un échec ne la remplace jamais. */
let comptesConnus: CompteDecrit[] | null = null;
const abonnes = new Set<(comptes: CompteDecrit[] | null) => void>();
let generation = 0;
let derniere: Promise<void> = Promise.resolve();
let enVol = false;
const RELANCE_MS = 4000;

/**
 * Relit la liste. Chaque appel démarre SA requête (jamais de réutilisation d'une
 * requête en vol : un `ready` suit un redémarrage, et la réponse d'avant lui peut
 * être périmée ou perdue) ; seule la plus récente fait foi. Un échec garde la
 * liste connue et relance plus tard tant que rien n'a jamais répondu.
 */
export function rafraichirComptes(): Promise<void> {
  const g = ++generation;
  enVol = true;
  derniere = chargerComptes().then((comptes) => {
    if (g !== generation) return;
    enVol = false;
    if (comptes === null) {
      if (comptesConnus === null && abonnes.size > 0) setTimeout(() => void rafraichirComptes(), RELANCE_MS);
      return;
    }
    comptesConnus = comptes;
    for (const cb of abonnes) cb(comptes);
  });
  return derniere;
}

/** Liste connue, en attendant une réponse si aucune n'est encore arrivée. `null` si l'appel échoue encore. */
export async function attendreComptes(): Promise<CompteDecrit[] | null> {
  if (comptesConnus === null) {
    if (!enVol) void rafraichirComptes(); // rien en vol (jamais lancé, ou échec précédent) : on réessaie maintenant
    // La requête la plus récente fait foi : on attend celle-là, pas une plus ancienne.
    let vue: Promise<void>;
    do {
      vue = derniere;
      await vue;
    } while (vue !== derniere);
  }
  return comptesConnus;
}

/** Test only : remet le magasin partagé à zéro. */
export function reinitialiserComptes(): void {
  comptesConnus = null;
  generation = 0;
  enVol = false;
  derniere = Promise.resolve();
}

/**
 * Compte du tour au moment de l'ENVOI : si le défaut du projet est `teams` et que
 * la liste est inconnue, l'envoi attend la réponse plutôt que de partir sur
 * `perso`. Liste toujours inconnue après l'attente : refus explicite.
 */
export async function compteAuDepart(
  choisi: CompteClaude | null,
  defautProjet: CompteClaude | null | undefined,
): Promise<{ compte: CompteClaude; repli: boolean }> {
  const premier = resoudreCompteSession(choisi, defautProjet, comptesConnus);
  if (!premier.attente) return { compte: premier.compte, repli: premier.repli };
  const liste = await attendreComptes();
  const r = resoudreCompteSession(choisi, defautProjet, liste);
  if (r.attente) throw new Error("Liste des comptes Claude indisponible : impossible de savoir quel compte sert ce projet. Réessayez dans un instant.");
  return { compte: r.compte, repli: r.repli };
}

/**
 * Comptes proposés, partagés par toutes les pages (un seul état). `null` = liste
 * pas encore connue. Relue quand le sidecar annonce « ready » (un redémarrage peut
 * suivre une connexion du second compte faite dans un terminal) et au retour de
 * focus.
 */
export function useComptesClaude(): CompteDecrit[] | null {
  const [comptes, setComptes] = useState<CompteDecrit[] | null>(comptesConnus);
  useEffect(() => {
    abonnes.add(setComptes);
    setComptes(comptesConnus);
    void rafraichirComptes();
    const off = subscribeReady(() => void rafraichirComptes());
    const auRetour = () => void rafraichirComptes();
    window.addEventListener("focus", auRetour);
    return () => {
      abonnes.delete(setComptes);
      off();
      window.removeEventListener("focus", auRetour);
    };
  }, []);
  return comptes;
}
