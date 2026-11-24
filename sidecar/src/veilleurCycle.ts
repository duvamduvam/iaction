/*
 * Veilleur du relais (docs/etude-veilleur-relais.md) — le CYCLE : une relève de
 * la boîte, le traitement de chaque message reçu, le dépôt de la réponse.
 *
 * Cœur à dépendances INJECTÉES (client de boîte, lanceur de tour, état
 * persistant, journal, générateur d'id, réception des pièces, valeurs du
 * coffre) : aucun HTTP, aucun moteur Claude, aucun disque ici. Le câblage réel
 * branche ces dépendances (veilleurService.ts) ; ce module tient l'ORDRE, qui
 * est le garde-fou. Testable avec des fakes.
 *
 * Ordre d'une relève :
 *   0. reprise : les réponses restées à déposer sont redéposées ; un message
 *      resté `en-cours` sans réponse (sidecar tué pendant le tour) reçoit une
 *      `info` « traitement interrompu » — jamais de ré-exécution ;
 *   1. émetteur non écouté : le fichier n'est ni téléchargé ni analysé ;
 *   2. message téléchargé PUIS la boîte relistée : même nom, émetteur, taille
 *      et date de dépôt exigés (le broker écrase un fichier de même nom et en
 *      réécrit l'émetteur) ; sinon rien n'est exécuté ni supprimé ;
 *   3. seule une `demande` peut lancer un tour : une `reponse` ou une `info`
 *      reste en boîte pour l'outil qui l'attend, jamais marquée ;
 *   4. décider (veilleurPolitique) — dédoublonnage, profondeur, quota ;
 *   5. pièces téléchargées en mémoire, chacune vérifiée inchangée ;
 *   6. marquer l'`id` `en-cours` AVANT tout effet de bord ;
 *   7. écrire les pièces dans `relais-recu/<fil>/`, lancer le tour ;
 *   8. garder le texte de la réponse (état) PUIS le déposer, marquer
 *      `repondu`, et seulement alors supprimer le message.
 * Une demande ne disparaît donc jamais sans réponse.
 *
 * Pièces de la réponse (T-230) : un dossier de sortie par demande est créé
 * avant le tour ; après, ses fichiers sont collectés (contrôle de dépôt du
 * relais) et déposés AVANT le message, sous un id de réponse fixé d'avance.
 * Leur contenu n'entre jamais dans l'état, seulement leurs noms : le message est
 * préparé AVANT les pièces, chaque dépôt confirmé est noté, et une reprise
 * redépose le MÊME message (même id) en n'annonçant que les confirmées — une
 * pièce ne se retire pas de la boîte d'un autre studio. Réponse retenue pour
 * secret (lignes de refus comprises), interrompue ou `info` : aucune pièce.
 *
 * Coût : connu en fin de tour (le moteur borne aussi la dépense). Au-delà du
 * plafond — ou inconnu après une interruption — la réponse part avec une
 * ligne qui le dit, puis le veilleur est SUSPENDU. Une réponse qui porterait
 * une valeur du coffre ou un secret de forme connue est RETENUE.
 *
 * Une erreur de l'ÉTAT (disque) fait échouer la relève entière, sans
 * suppression : `bilan.erreur` le dit au service.
 */

import { motifSecretDansContenu } from "./fichiersSecrets.js";
import { lireMessage, serialiserMessage, type MessageVeilleur, type TypeMessage } from "./veilleurMessage.js";
import { expediteurEcoute, motifRefus, profondeurSuivante, type Plafonds } from "./veilleurPolitique.js";

export interface FichierBoite {
  /** Nom du fichier dans la boîte. */
  nom: string;
  /** Studio émetteur, tel que le broker l'a prouvé par le jeton. */
  de: string;
  /** Taille en octets, si le broker la donne. */
  taille?: number;
  /** Date de dépôt, si le broker la donne. */
  deposeLe?: number | string;
}

export interface ClientBoite {
  listerRecus(): Promise<FichierBoite[]>;
  telecharger(nom: string): Promise<string>;
  /** Contenu binaire (messages et pièces). */
  telechargerBrut(nom: string): Promise<Buffer>;
  deposer(dest: string, nom: string, contenu: string): Promise<void>;
  /** Dépôt binaire (pièces jointes). */
  deposerBrut(dest: string, nom: string, contenu: Buffer): Promise<void>;
  supprimer(nom: string): Promise<void>;
}

/** Nom d'une pièce dans la boîte : `<id du message>-<nom>`. */
export function nomPieceEnBoite(idMessage: string, nom: string): string {
  return `${idMessage}-${nom}`;
}

/** Pièces d'un message, telles que reçues avant le tour. */
export interface PiecesRecues {
  /** Chemins écrits, relatifs à la racine du projet (`relais-recu/<fil>/…`). */
  ecrites: string[];
  /** Pièces annoncées mais non écrites, avec la raison. */
  refusees: { nom: string; raison: string }[];
}

export interface ContexteTour {
  pieces: PiecesRecues;
  /** Abandon demandé (veilleur arrêté) : le lanceur interrompt le tour. */
  signal?: AbortSignal;
  /** Dossier de sortie (relatif à la racine du projet) où l'agent dépose ce qu'il renvoie ; absent : aucun. */
  sortie?: string;
}

/** Ce que l'agent a laissé dans le dossier de sortie, après contrôle. */
export interface SortieCollectee {
  pieces: { nom: string; contenu: Buffer }[];
  /** `raison` PART avec la réponse (jamais de chemin du poste) ; `detail` reste au journal local. */
  refusees: { nom: string; raison: string; detail?: string }[];
}

/** Code d'une erreur système (`EBUSY`, `EACCES`…) : la seule part d'une erreur qui puisse partir avec une réponse. */
export function codeErreur(e: unknown): string {
  const c = (e as NodeJS.ErrnoException | null)?.code;
  return typeof c === "string" && /^[A-Z0-9_]{2,20}$/.test(c) ? c : "erreur";
}

/** Ce que rend un tour. */
export interface IssueTour {
  corps: string;
  /** Coût de CE message en $, `null` si inconnu. */
  coutUsd: number | null;
  /** Tour interrompu (délai, arrêt) : un coût inconnu compte alors comme un dépassement. */
  interrompu?: boolean;
  /** Le moteur a arrêté le tour sur le plafond de coût. */
  depassement?: boolean;
  /** Le tour exige la suspension du veilleur (périmètre constaté non conforme) : le motif. */
  suspension?: string;
}

/**
 * Lance le tour d'agent pour un message. Le lanceur applique lui-même la borne
 * de durée ; le plafond de coût est passé au moteur et vérifié ici après coup.
 * Il ne lève pas ; un échec de tour rend un corps d'échec lisible.
 */
export type LanceurTour = (m: MessageVeilleur, de: string, ctx: ContexteTour) => Promise<IssueTour>;

/** Réponse gardée dans l'état tant qu'elle n'est pas déposée. */
export interface ReponseEnAttente {
  dest: string;
  nom: string;
  contenu: string;
  /**
   * Pièces de la réponse (noms seulement, jamais leur contenu) : annoncées par le
   * message préparé, et déposées chez le destinataire avec certitude. Une reprise
   * redépose le message (même id) en n'annonçant que les confirmées.
   */
  pieces?: { prevues: string[]; confirmees: string[] };
}

/** Message marqué `en-cours` (son dépôt de réponse n'a pas encore réussi). */
export interface EntreeEnCours {
  id: string;
  /** Nom du message dans la boîte. */
  nom: string;
  de: string;
  fil: string;
  profondeur: number;
  reponse?: ReponseEnAttente;
}

export interface EtatVeilleur {
  idsTraites(): Promise<string[]>;
  statutDe(id: string): Promise<"en-cours" | "repondu" | null>;
  marquerEnCours(m: Omit<EntreeEnCours, "reponse">): Promise<void>;
  preparerReponse(id: string, r: ReponseEnAttente): Promise<void>;
  marquerRepondu(id: string): Promise<void>;
  enCours(): Promise<EntreeEnCours[]>;
  toursAujourdhui(): Promise<number>;
  incrementerTour(): Promise<void>;
  /** Suspension en cours (motif, date ISO), ou `null`. */
  suspension(): Promise<{ motif: string; le: string } | null>;
  suspendre(motif: string): Promise<void>;
  lever(): Promise<void>;
}

export type JournalVeilleur = (
  niveau: "info" | "warn" | "error",
  message: string,
  champs?: Record<string, unknown>,
) => void;

export interface ConfigVeilleur {
  /** Studios écoutés (la maison). */
  expediteurs: string[];
  plafonds: Plafonds;
}

/**
 * Écrit une pièce reçue dans `relais-recu/<fil>/<nom>` du projet, avec les
 * règles du relais (relaisFichiers.ts). Rend le chemin relatif écrit, ou un refus.
 */
export type RecevoirPiece = (fil: string, nom: string, contenu: Buffer) => Promise<{ chemin: string } | { refus: string }>;

export interface DepsVeilleur {
  boite: ClientBoite;
  lancer: LanceurTour;
  etat: EtatVeilleur;
  journal: JournalVeilleur;
  config: ConfigVeilleur;
  /** Génère l'`id` d'un message de réponse. */
  nouvelId: () => string;
  /** Réception des pièces ; absente, toute pièce est signalée non reçue. */
  recevoirPiece?: RecevoirPiece;
  /** Valeurs du coffre : une réponse qui en porte une est retenue. */
  valeursSecretes?: () => Promise<string[]>;
  /** Crée le dossier de sortie (vide) de la demande `id` ; rend son chemin relatif. Absente : pas de pièce en réponse. */
  preparerSortie?: (id: string) => Promise<string>;
  /** Collecte, contrôle et rend les fichiers du dossier de sortie. */
  collecterSortie?: (id: string) => Promise<SortieCollectee>;
  /** Supprime le dossier de sortie, une fois le message déposé. */
  supprimerSortie?: (id: string) => Promise<void>;
  /** Retire les dossiers de sortie des demandes déjà répondues (ou trop vieux) ; rend les échecs. */
  nettoyerSorties?: (repondus: string[]) => Promise<{ retires: number; echecs: { nom: string; cause: string }[] }>;
  /** Arrêt du veilleur : plus de nouveau message, le tour en cours s'interrompt. */
  signal?: AbortSignal;
  /** Ce qui a déjà été signalé au journal (une fois par processus) ; défaut : mémoire du module. */
  dejaSignales?: Set<string>;
}

/** Ce qu'une relève a fait, pour le journal et les tests. */
export interface BilanReleve {
  traites: string[];
  refuses: string[];
  ignores: string[];
  invalides: string[];
  /** Réponses redéposées ou interruptions signalées (reprise). */
  repris?: string[];
  /** Le veilleur a été suspendu pendant cette relève (coût). */
  suspendu?: boolean;
  /** Relève en échec (liste de la boîte, état illisible) : le motif, sans jeton. */
  erreur?: string;
}

/** Bilan sans rien dedans ? (le service ne journalise que les bilans non vides) */
export function bilanVide(b: BilanReleve): boolean {
  return b.traites.length + b.refuses.length + b.ignores.length + b.invalides.length + (b.repris?.length ?? 0) === 0 && !b.suspendu && !b.erreur;
}

const signalesDuProcessus = new Set<string>();

/** Première fois que `cle` est signalée (puis plus rien) ? */
function premiereFois(deps: DepsVeilleur, cle: string): boolean {
  const s = deps.dejaSignales ?? signalesDuProcessus;
  if (s.has(cle)) return false;
  s.add(cle);
  return true;
}

export const CORPS_INTERROMPU =
  "Traitement interrompu avant la réponse : l'application s'est arrêtée pendant le tour. Renvoie la demande si besoin (elle n'est pas rejouée d'office).";

/** Erreur de l'état persistant : elle arrête la relève (rien n'est supprimé). */
class ErreurEtat extends Error {}

function envelopperEtat(etat: EtatVeilleur): EtatVeilleur {
  const e = {} as Record<string, unknown>;
  for (const cle of Object.keys(etat) as (keyof EtatVeilleur)[]) {
    const f = etat[cle] as (...a: unknown[]) => Promise<unknown>;
    e[cle] = async (...a: unknown[]) => {
      try {
        return await f.apply(etat, a);
      } catch (err) {
        throw new ErreurEtat(err instanceof Error ? err.message : String(err));
      }
    };
  }
  return e as unknown as EtatVeilleur;
}

/** Un fichier de la boîte est-il un message du veilleur ? (`msg-*.md`) */
export function estNomMessage(nom: string): boolean {
  return /^msg-.+\.md$/.test(nom);
}

function reponse(
  m: Pick<MessageVeilleur, "fil" | "id" | "profondeur">,
  type: TypeMessage,
  corps: string,
  nouvelId: () => string,
  /** `id` déjà fixé (les pièces portent l'id de la réponse) et noms des pièces déposées. */
  avec: { id?: string; pieces?: string[] } = {},
): { nom: string; contenu: string } {
  const id = avec.id ?? nouvelId();
  const contenu = serialiserMessage({
    fil: m.fil,
    id,
    type,
    profondeur: profondeurSuivante(m.profondeur),
    enReponseA: m.id,
    ...(avec.pieces && avec.pieces.length > 0 ? { pieces: avec.pieces } : {}),
    corps,
  });
  return { nom: `msg-${id}.md`, contenu };
}

/** Même entrée qu'à la liste (nom, émetteur, taille, date), et la taille lue concorde. */
async function inchange(deps: DepsVeilleur, f: FichierBoite, octetsLus: number): Promise<boolean> {
  return inchangeDansBoite(deps.boite, f, octetsLus);
}

/**
 * Le fichier lu est-il encore celui de la liste (nom, émetteur, taille, date
 * de dépôt) ? Le broker écrase un fichier de même nom et en réécrit
 * l'émetteur : seconde liste après lecture. Partagé avec outilsRelaisVeilleur.ts.
 */
export async function inchangeDansBoite(boite: ClientBoite, f: FichierBoite, octetsLus: number): Promise<boolean> {
  const g = (await boite.listerRecus()).find((x) => x.nom === f.nom);
  if (!g || g.de !== f.de || g.taille !== f.taille || g.deposeLe !== f.deposeLe) return false;
  return f.taille === undefined || f.taille === octetsLus;
}

/**
 * Une relève : lit la boîte, reprend ce qui reste à répondre, traite chaque
 * message `msg-*.md`. Ne lève jamais — un échec sur un message est journalisé
 * et n'empêche pas les suivants ; un échec de l'état arrête la relève. Un
 * veilleur suspendu ne relève rien.
 */
export async function uneReleve(depsBrutes: DepsVeilleur): Promise<BilanReleve> {
  const deps = { ...depsBrutes, etat: envelopperEtat(depsBrutes.etat) };
  const bilan: BilanReleve = { traites: [], refuses: [], ignores: [], invalides: [] };
  try {
    if (await deps.etat.suspension()) return bilan;
  } catch (e) {
    bilan.erreur = e instanceof Error ? e.message : String(e);
    return bilan;
  }
  let recus: FichierBoite[];
  try {
    recus = await deps.boite.listerRecus();
  } catch (e) {
    // Journalisé par le service, à la transition seulement (pas toutes les 30 s).
    bilan.erreur = `lecture de la boîte impossible : ${e instanceof Error ? e.message : String(e)}`;
    return bilan;
  }

  const retires = new Set<string>();
  try {
    await reprendre(deps, recus, retires, bilan);
    await nettoyerReliquats(deps);
  } catch (e) {
    if (!(e instanceof ErreurEtat)) throw e;
    bilan.erreur = e.message;
    return bilan;
  }

  const signales = deps.dejaSignales ?? signalesDuProcessus;
  for (const f of recus) {
    if (deps.signal?.aborted || bilan.suspendu) break;
    if (!estNomMessage(f.nom) || retires.has(f.nom)) continue;
    // Émetteur non écouté : ni téléchargé, ni analysé.
    if (!expediteurEcoute(f.de, deps.config.expediteurs)) {
      if (!signales.has(`emetteur:${f.nom}`)) {
        signales.add(`emetteur:${f.nom}`);
        deps.journal("info", "message d'un émetteur non écouté : laissé en boîte, non lu", { nom: f.nom, de: f.de });
      }
      bilan.ignores.push(f.nom);
      continue;
    }
    try {
      await traiterUn(deps, f, recus, bilan);
    } catch (e) {
      if (e instanceof ErreurEtat) {
        deps.journal("error", "relève arrêtée : état du veilleur en échec", { nom: f.nom, cause: e.message });
        bilan.erreur = e.message;
        break;
      }
      // Garde ultime : un message ne fait jamais tomber la relève entière.
      deps.journal("error", "relève : message en échec", { nom: f.nom, de: f.de, cause: String(e) });
    }
  }
  return bilan;
}

/** Étape 0 : redéposer les réponses en attente, signaler les tours interrompus. */
async function reprendre(deps: DepsVeilleur, recus: FichierBoite[], retires: Set<string>, bilan: BilanReleve): Promise<void> {
  for (const e of await deps.etat.enCours()) {
    let r = e.reponse;
    if (!r) {
      const info = reponse(e, "info", CORPS_INTERROMPU, deps.nouvelId);
      r = { dest: e.de, ...info };
      await deps.etat.preparerReponse(e.id, r);
      deps.journal("warn", "tour interrompu avant sa réponse : l'émetteur en est informé", { id: e.id, fil: e.fil, de: e.de });
    } else {
      const complete = reconstruire(r);
      if (complete !== r) {
        r = complete;
        await deps.etat.preparerReponse(e.id, r);
        deps.journal("warn", "pièces de la réponse non toutes confirmées : le message part sans les manquantes (elles ne sont pas annoncées)", { id: e.id, fil: e.fil });
      }
    }
    try {
      await deps.boite.deposer(r.dest, r.nom, r.contenu);
    } catch (err) {
      if (premiereFois(deps, `redepot:${e.id}`)) {
        deps.journal("warn", "réponse en attente non redéposée, nouvel essai à chaque relève", { id: e.id, cause: String(err) });
      }
      continue;
    }
    await deps.etat.marquerRepondu(e.id);
    await retirerSortie(deps, e.id);
    (bilan.repris ??= []).push(e.id);
    if (recus.some((x) => x.nom === e.nom)) {
      await deps.boite.supprimer(e.nom).catch((err: unknown) => deps.journal("warn", "message répondu non retiré de la boîte", { nom: e.nom, cause: String(err) }));
      retires.add(e.nom);
    }
  }
}

/**
 * Pièces annoncées : téléchargées en MÉMOIRE (`<id>-<nom>`, même émetteur),
 * chacune vérifiée inchangée. Une pièce manquante ou illisible devient un
 * refus dit à l'agent ; une pièce SUBSTITUÉE fait abandonner tout le message
 * (`null`).
 */
async function telechargerPieces(
  deps: DepsVeilleur,
  m: MessageVeilleur,
  de: string,
  recus: FichierBoite[],
): Promise<{ lues: { nom: string; nomBoite: string; contenu: Buffer }[]; refusees: { nom: string; raison: string }[] } | null> {
  const lues: { nom: string; nomBoite: string; contenu: Buffer }[] = [];
  const refusees: { nom: string; raison: string }[] = [];
  for (const nom of m.pieces ?? []) {
    const nomBoite = nomPieceEnBoite(m.id, nom);
    const f = recus.find((r) => r.nom === nomBoite && r.de === de);
    if (!f) {
      refusees.push({ nom, raison: "absente de la boîte" });
      continue;
    }
    let contenu: Buffer;
    try {
      contenu = await deps.boite.telechargerBrut(nomBoite);
    } catch (e) {
      refusees.push({ nom, raison: `téléchargement impossible (${String(e)})` });
      continue;
    }
    if (!(await inchange(deps, f, contenu.length))) return null;
    lues.push({ nom, nomBoite, contenu });
  }
  return { lues, refusees };
}

/** Supprime le dossier de sortie d'une demande répondue ; un échec se dit, jamais une erreur. */
async function retirerSortie(deps: DepsVeilleur, id: string): Promise<void> {
  if (!deps.supprimerSortie) return;
  try {
    await deps.supprimerSortie(id);
  } catch (e) {
    deps.journal("warn", "dossier de sortie non supprimé", { id, cause: String(e) });
  }
}

/** Nombre de refus détaillés dans le corps ; le reste est compté. */
const REFUS_DETAILLES = 20;

/**
 * Collecte les pièces de la réponse. Un nom (de pièce ou de refus) qui porte un
 * secret est remplacé : il partirait dans l'en-tête, le nom en boîte et le corps.
 * Rien d'autre que `raison` ne quitte le poste ; `detail` va au journal.
 */
async function collecter(deps: DepsVeilleur, m: MessageVeilleur, valeurs: string[], collecterSortie: NonNullable<DepsVeilleur["collecterSortie"]>): Promise<SortieCollectee> {
  let brut: SortieCollectee;
  try {
    brut = await collecterSortie(m.id);
  } catch (e) {
    brut = { pieces: [], refusees: [{ nom: "dossier de sortie", raison: `collecte impossible (${codeErreur(e)})`, detail: String(e) }] };
  }
  const porteSecret = (t: string) => motifSecretDansContenu(Buffer.from(t, "utf8"), valeurs) !== null;
  const NOM_RETENU = "(nom retenu)";
  const sortie: SortieCollectee = { pieces: [], refusees: [] };
  for (const x of brut.refusees) sortie.refusees.push(porteSecret(`${x.nom}\n${x.raison}`) ? { nom: NOM_RETENU, raison: "refusé (le nom portait un secret)" } : x);
  for (const p of brut.pieces) {
    if (porteSecret(p.nom)) sortie.refusees.push({ nom: NOM_RETENU, raison: "refusé (le nom portait un secret)" });
    else sortie.pieces.push(p);
  }
  for (const x of sortie.refusees) deps.journal("warn", "pièce de la réponse non envoyée", { id: m.id, fil: m.fil, piece: x.nom, raison: x.raison, ...(x.detail ? { detail: x.detail } : {}) });
  return sortie;
}

/** Lignes « Pièces non envoyées » ajoutées en fin de corps (vide si aucun refus). */
function ligneRefus(refusees: { nom: string; raison: string }[], titre = "Pièces non envoyées"): string {
  if (refusees.length === 0) return "";
  const lignes = refusees.slice(0, REFUS_DETAILLES).map((p) => `- ${p.nom} : ${p.raison}`);
  if (refusees.length > REFUS_DETAILLES) lignes.push(`- … et ${refusees.length - REFUS_DETAILLES} autre(s)`);
  return `\n\n${titre} :\n${lignes.join("\n")}`;
}

/**
 * Réponse préparée dont des pièces n'ont pas été confirmées (arrêt pendant
 * l'envoi) : MÊME id, message qui n'annonce que les confirmées et dit les
 * manquantes. Une pièce déposée dans la boîte d'un autre studio ne se retire
 * pas (le relais ne supprime que dans sa propre boîte) : un nouvel id la
 * laisserait orpheline et muette.
 */
function reconstruire(r: ReponseEnAttente): ReponseEnAttente {
  const p = r.pieces;
  const manquantes = p ? p.prevues.filter((n) => !p.confirmees.includes(n)) : [];
  if (!p || manquantes.length === 0) return r;
  const lu = lireMessage(r.contenu);
  if ("invalide" in lu) return r;
  const m = { ...lu.message };
  delete m.pieces;
  if (p.confirmees.length > 0) m.pieces = [...p.confirmees];
  m.corps += ligneRefus(manquantes.map((nom) => ({ nom, raison: "dépôt non confirmé : le veilleur s'est arrêté pendant l'envoi" })), "Pièces non confirmées");
  return { dest: r.dest, nom: r.nom, contenu: serialiserMessage(m), pieces: { prevues: [...p.confirmees], confirmees: [...p.confirmees] } };
}

/** Retire les dossiers de sortie des demandes répondues dont la suppression avait échoué ; dit l'échec une fois. */
async function nettoyerReliquats(deps: DepsVeilleur): Promise<void> {
  if (!deps.nettoyerSorties) return;
  const repondus: string[] = [];
  for (const id of await deps.etat.idsTraites()) if ((await deps.etat.statutDe(id)) === "repondu") repondus.push(id);
  try {
    for (const x of (await deps.nettoyerSorties(repondus)).echecs) {
      if (premiereFois(deps, `sortie:${x.nom}`)) deps.journal("warn", "dossier de sortie non supprimé, nouvel essai à chaque relève", { dossier: x.nom, cause: x.cause });
    }
  } catch (e) {
    if (premiereFois(deps, "nettoyage-sorties")) deps.journal("warn", "nettoyage des dossiers de sortie impossible", { cause: String(e) });
  }
}

async function traiterUn(deps: DepsVeilleur, f: FichierBoite, recus: FichierBoite[], bilan: BilanReleve): Promise<void> {
  const brut = await deps.boite.telechargerBrut(f.nom);
  if (!(await inchange(deps, f, brut.length))) {
    deps.journal("warn", "message modifié dans la boîte entre la liste et la lecture : rien n'est exécuté", { nom: f.nom, de: f.de });
    return;
  }
  const lu = lireMessage(brut.toString("utf8"));
  if ("invalide" in lu) {
    // Une ligne par nom, puis silence (le service vide la mémoire au changement d'état).
    if (premiereFois(deps, `invalide:${f.nom}`)) deps.journal("warn", "message invalide, laissé en boîte", { nom: f.nom, de: f.de, raison: lu.invalide });
    bilan.invalides.push(f.nom);
    return;
  }
  const m = lu.message;

  // Seule une demande s'exécute. Une réponse ou une info reste en boîte pour
  // l'outil qui l'attend ; signalée une fois par processus, pas à chaque relève.
  if (m.type !== "demande") {
    const signales = deps.dejaSignales ?? signalesDuProcessus;
    if (!signales.has(m.id)) {
      signales.add(m.id);
      deps.journal("info", "message non exécuté : seules les demandes lancent un tour", { nom: f.nom, de: f.de, type: m.type, fil: m.fil });
    }
    bilan.ignores.push(m.id);
    return;
  }

  const refus = motifRefus({
    de: f.de,
    ecoutes: deps.config.expediteurs,
    id: m.id,
    profondeur: m.profondeur,
    coutEstime: null, // inconnu a priori : le moteur borne la dépense, constatée en fin de tour
    toursAujourdhui: await deps.etat.toursAujourdhui(),
    idsTraites: await deps.etat.idsTraites(),
    plafonds: deps.config.plafonds,
  });

  const meta = { id: m.id, nom: f.nom, de: f.de, fil: m.fil, profondeur: m.profondeur };
  if (refus) {
    if (refus.silencieux) {
      // Déjà répondu : reliquat, on retire. En cours : la reprise s'en charge (jamais retiré sans réponse).
      if (refus.motif.includes("déjà traité") && (await deps.etat.statutDe(m.id)) === "repondu") await deps.boite.supprimer(f.nom);
      deps.journal("info", "message non exécuté", { nom: f.nom, de: f.de, motif: refus.motif });
      bilan.ignores.push(m.id);
      return;
    }
    // Refus répondu : marqué, réponse gardée, déposée, puis seulement retiré.
    await deps.etat.marquerEnCours(meta);
    const r = reponse(m, "info", `Demande non traitée — ${refus.motif}.`, deps.nouvelId);
    if (await deposer(deps, m.id, f.de, r)) await deps.boite.supprimer(f.nom);
    deps.journal("warn", "message refusé, émetteur informé", { nom: f.nom, de: f.de, motif: refus.motif });
    bilan.refuses.push(m.id);
    return;
  }

  // Pièces en mémoire et vérifiées AVANT tout marquage : une substitution n'exécute rien.
  const telechargees = await telechargerPieces(deps, m, f.de, recus);
  if (!telechargees) {
    deps.journal("warn", "pièce modifiée dans la boîte entre la liste et la lecture : rien n'est exécuté", { nom: f.nom, de: f.de, fil: m.fil });
    return;
  }

  // Exécuté. Marquage AVANT l'effet de bord : zéro double action.
  await deps.etat.marquerEnCours(meta);
  await deps.etat.incrementerTour();
  deps.journal("info", "tour lancé", { nom: f.nom, de: f.de, fil: m.fil, id: m.id, pieces: m.pieces?.length ?? 0 });

  const pieces: PiecesRecues = { ecrites: [], refusees: [...telechargees.refusees] };
  for (const p of telechargees.lues) {
    try {
      const r = deps.recevoirPiece ? await deps.recevoirPiece(m.fil, p.nom, p.contenu) : { refus: "réception des pièces indisponible" };
      if ("chemin" in r) pieces.ecrites.push(r.chemin);
      else pieces.refusees.push({ nom: p.nom, raison: r.refus });
    } catch (e) {
      pieces.refusees.push({ nom: p.nom, raison: `écriture impossible (${String(e)})` });
    }
    // Écrite ou refusée, elle ne sera jamais reprise : elle quitte la boîte.
    await deps.boite.supprimer(p.nomBoite).catch((e: unknown) => deps.journal("warn", "pièce non retirée de la boîte", { piece: p.nomBoite, cause: String(e) }));
  }
  for (const p of pieces.refusees) deps.journal("warn", "pièce non reçue", { id: m.id, fil: m.fil, piece: p.nom, raison: p.raison });

  // Dossier de sortie créé (vide) avant le tour ; un échec se dit, le tour part sans.
  let sortie: string | undefined;
  if (deps.preparerSortie) {
    try {
      sortie = await deps.preparerSortie(m.id);
    } catch (e) {
      deps.journal("warn", "dossier de sortie non créé : la réponse partira sans pièce", { id: m.id, fil: m.fil, cause: String(e) });
    }
  }

  const issue = await deps.lancer(m, f.de, { pieces, ...(sortie ? { sortie } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });

  const plafond = deps.config.plafonds.coutParMessage;
  const inconnuApresInterruption = issue.interrompu === true && issue.coutUsd === null;
  const depasse =
    issue.suspension !== undefined || (plafond > 0 && (issue.depassement === true || inconnuApresInterruption || (issue.coutUsd !== null && issue.coutUsd > plafond)));
  const motifSuspension = !depasse
    ? ""
    : issue.suspension !== undefined
      ? issue.suspension
      : inconnuApresInterruption
      ? "coût inconnu après l'interruption du tour, traité comme un dépassement"
      : `coût du tour ${(issue.coutUsd ?? plafond).toFixed(2)} $ au-delà du plafond de ${plafond.toFixed(2)} $/message`;

  // Le contrôle porte sur le corps FINAL, lignes de refus des pièces comprises : retenu, plus aucune pièce ne part.
  const valeurs = deps.valeursSecretes ? await deps.valeursSecretes() : [];
  const secretDans = (t: string) => motifSecretDansContenu(Buffer.from(t, "utf8"), valeurs);
  let motifSecret = secretDans(issue.corps);
  let collecte: SortieCollectee = { pieces: [], refusees: [] };
  // Aucune pièce si la réponse est retenue (secret) ou interrompue.
  if (!motifSecret && sortie !== undefined && issue.interrompu !== true && deps.collecterSortie) {
    collecte = await collecter(deps, m, valeurs, deps.collecterSortie);
    motifSecret = secretDans(`${issue.corps}${ligneRefus(collecte.refusees)}`);
    if (motifSecret) collecte = { pieces: [], refusees: [] };
  }
  let corps = issue.corps;
  if (motifSecret) {
    deps.journal("warn", "réponse retenue : elle portait un secret", { id: m.id, fil: m.fil, motif: motifSecret });
    corps = `Réponse retenue : elle contenait ${motifSecret}.`;
  }
  if (depasse) corps = `${corps}\n\n— ${motifSuspension} : le veilleur est suspendu jusqu'à sa réactivation par un humain.`;

  try {
    // L'id de la réponse est fixé AVANT les pièces (elles le portent dans leur nom en boîte).
    const idReponse = deps.nouvelId();
    const refus = [...collecte.refusees];
    const prevues = collecte.pieces.map((p) => p.nom);
    const confirmees: string[] = [];
    const composer = (annoncees: string[]) => reponse(m, "reponse", `${corps}${ligneRefus(refus)}`, deps.nouvelId, { id: idReponse, pieces: annoncees });
    if (prevues.length > 0) {
      // Message préparé AVANT les pièces : un arrêt en cours d'envoi laisse de quoi redéposer sous le même id.
      await deps.etat.preparerReponse(m.id, { dest: f.de, ...composer(prevues), pieces: { prevues, confirmees: [] } });
      for (const p of collecte.pieces) {
        try {
          await deps.boite.deposerBrut(f.de, nomPieceEnBoite(idReponse, p.nom), p.contenu);
        } catch (e) {
          refus.push({ nom: p.nom, raison: `dépôt impossible (${codeErreur(e)})` });
          deps.journal("warn", "pièce de la réponse non envoyée", { id: m.id, fil: m.fil, piece: p.nom, raison: "dépôt impossible", detail: String(e) });
          continue;
        }
        confirmees.push(p.nom);
        await deps.etat.preparerReponse(m.id, { dest: f.de, ...composer(prevues), pieces: { prevues, confirmees: [...confirmees] } });
      }
    }
    const r = composer(confirmees);
    if (await deposer(deps, m.id, f.de, r, prevues.length > 0 ? { prevues: [...confirmees], confirmees } : undefined)) {
      await deps.boite.supprimer(f.nom);
      deps.journal("info", "réponse déposée", { fil: m.fil, enReponseA: m.id, de: f.de, coutUsd: issue.coutUsd, pieces: confirmees.length });
      await retirerSortie(deps, m.id);
    }
    bilan.traites.push(m.id);
  } finally {
    // Dépôt réussi ou non, un dépassement suspend : la dépense est faite.
    if (depasse) {
      await deps.etat.suspendre(motifSuspension);
      bilan.suspendu = true;
      deps.journal("warn", "veilleur suspendu", { motif: motifSuspension, fil: m.fil, id: m.id });
    }
  }
}

/**
 * Garde la réponse dans l'état, puis la dépose et marque `repondu`. Un dépôt
 * raté laisse la réponse en attente (redéposée à la relève suivante) : `false`.
 */
async function deposer(deps: DepsVeilleur, id: string, dest: string, r: { nom: string; contenu: string }, pieces?: ReponseEnAttente["pieces"]): Promise<boolean> {
  await deps.etat.preparerReponse(id, { dest, ...r, ...(pieces ? { pieces } : {}) });
  try {
    await deps.boite.deposer(dest, r.nom, r.contenu);
  } catch (e) {
    deps.journal("warn", "dépôt de la réponse en échec, gardée pour la prochaine relève", { id, dest, cause: String(e) });
    return false;
  }
  await deps.etat.marquerRepondu(id);
  return true;
}
