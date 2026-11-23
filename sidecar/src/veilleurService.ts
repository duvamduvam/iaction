/*
 * Veilleur du relais — le SERVICE : la boucle de relève d'un poste, dans le
 * sidecar, tant que l'application est ouverte (docs/etude-veilleur-relais.md
 * § 0 et § 3.3).
 *
 * Un seul projet veilleur par poste, mémorisé dans
 * `<config>/net.duvam.iaction/veilleur/poste.json` (`{ cwd }`), hors projet.
 * Au lancement du sidecar, si ce projet a une config valide et `actif: true`,
 * le service démarre seul.
 *
 * À chaque battement (`cadenceSec`) :
 *   config relue → suspension ? → coffre ouvert ? → **scellé** : l'empreinte
 *   de la config relue doit être celle rangée au coffre à l'enregistrement
 *   (`veilleur.empreinte.<projet>`) — sinon `invalide`, AUCUNE requête réseau, aucun
 *   tour → jeton au coffre → client de boîte → une relève (veilleurCycle.ts).
 * Le scellé protège la config (adresse, secret, émetteurs, plafonds, agent,
 * autorité) : un agent avec Bash peut réécrire `veilleur.json`, pas en forger
 * l'approbation — elle n'est lue que de la classe `coffre`. Il peut en
 * revanche écrire `etat.json`, `fils.json`, `poste.json` : le scellé ne
 * protège pas la disponibilité (quota, suspension, relance).
 *
 * Jamais deux relèves à la fois. Le contrôleur d'arrêt de la relève est créé
 * AVANT tout `await` ; après un arrêt, aucun battement ne repart. Tant qu'un
 * tour interrompu n'a pas rendu la main, l'état est `arret-en-cours`, jamais
 * `inactif`.
 *
 * États : `inactif`, `actif`, `suspendu`, `en-attente-coffre`, `invalide`
 * (config, scellé, jeton, autorité, état illisible, boîte injoignable),
 * `arret-en-cours`. Chaque transition est journalisée (canal `relais`) et
 * poussée à l'interface — une fois, pas à chaque battement. Le jeton ne
 * quitte jamais la mémoire.
 *
 * Tout est injectable : les tests tournent sans réseau ni moteur.
 */

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { globalConfigRoot } from "./appPaths.js";
import { errMessage } from "./base.js";
import * as journalApp from "./journal.js";
import { coffreChiffreContient, etatDuCoffre, readSecrets, type EtatCoffre } from "./mcpSecrets.js";
import { ecrireRecu } from "./relaisFichiers.js";
import { creerClientBoite } from "./veilleurBoite.js";
import { CADENCE_DEFAUT_SEC, lireConfigVeilleur, MOTIF_SCELLE, scellePour, type ConfigVeilleur } from "./veilleurConfig.js";
import { uneReleve, type BilanReleve, type ClientBoite, type EtatVeilleur, type JournalVeilleur, type LanceurTour, type RecevoirPiece } from "./veilleurCycle.js";
import { creerEtatFichier } from "./veilleurEtat.js";
import { creerMemoireFils, type MemoireFils } from "./veilleurFils.js";
import { creerLanceur } from "./veilleurLanceur.js";

export type EtatService = "inactif" | "actif" | "suspendu" | "en-attente-coffre" | "invalide" | "arret-en-cours" | "bloque";

export { MOTIF_SCELLE } from "./veilleurConfig.js";

export interface StatutVeilleur {
  etat: EtatService;
  /** Projet veilleur du poste (`null` : aucun). */
  cwd: string | null;
  motif?: string;
  /** Date ISO de la dernière relève. */
  derniereReleve?: string;
  dernierBilan?: BilanReleve;
  toursAujourdhui: number;
  /** Une relève (donc peut-être un tour) est en cours. */
  enCours: boolean;
}

export interface DepsService {
  /** Dossier des fichiers du poste (défaut : `<config>/net.duvam.iaction/veilleur`). */
  dossier?: string;
  lireConfig?: (cwd: string) => ReturnType<typeof lireConfigVeilleur>;
  etatCoffre?: () => EtatCoffre;
  secrets?: () => Promise<Record<string, string>>;
  /** Le coffre ouvert (lui seul, jamais l'ancien fichier en clair) porte-t-il ce scellé sous ce nom ? */
  scelle?: (nom: string, empreinte: string) => boolean;
  client?: (config: ConfigVeilleur, jeton: string, ca: string | undefined) => ClientBoite;
  lireCa?: (chemin: string) => Promise<string>;
  creerEtat?: (chemin: string) => EtatVeilleur;
  fils?: MemoireFils;
  lanceur?: (cwd: string, config: ConfigVeilleur, journal: JournalVeilleur, fils: MemoireFils, surBlocage: (motif: string) => void) => LanceurTour;
  releve?: typeof uneReleve;
  /** Répétition (défaut : `setInterval`) ; rend l'annulation. */
  repeter?: (fn: () => void, ms: number) => () => void;
  maintenant?: () => number;
  nouvelId?: () => string;
  /** Poussée vers l'interface à chaque changement d'état. */
  notifier?: (s: StatutVeilleur) => void;
  journal?: JournalVeilleur;
}

export interface ServiceVeilleur {
  demarrer(cwd: string): Promise<StatutVeilleur>;
  /** Arrête ; rend `arret-en-cours` tant que le tour interrompu n'a pas rendu la main. */
  arreter(): Promise<StatutVeilleur>;
  statut(): Promise<StatutVeilleur>;
  /** Lève une suspension (geste humain : `veilleur.activer`). */
  lever(): Promise<void>;
  /** Lancement du sidecar : redémarre le veilleur du poste si sa config le dit. */
  demarrerAuLancement(): Promise<void>;
  /** Un battement (exposé pour les tests). */
  battement(): Promise<void>;
  /** Oublie le poste (`poste.json` retiré) : plus de redémarrage au lancement ; `projetAussi` : le statut ne le nomme plus. */
  oublierPoste(projetAussi?: boolean): Promise<void>;
  /** Sortie du sidecar : arrêt et interruption du tour en cours, attente bornée (`true` : tout a rendu la main). */
  arreterPourSortir(borneMs: number): Promise<boolean>;
}

function journalParDefaut(niveau: "info" | "warn" | "error", message: string, champs?: Record<string, unknown>): void {
  journalApp[niveau]("relais", message, { fields: champs ?? {} });
}

function repeterReel(fn: () => void, ms: number): () => void {
  const t = setInterval(fn, ms);
  return () => clearInterval(t);
}

/** Bilan aplati pour le journal (scalaires seulement). */
function champsBilan(b: BilanReleve): Record<string, unknown> {
  return {
    traites: b.traites.length,
    refuses: b.refuses.length,
    ignores: b.ignores.length,
    invalides: b.invalides.length,
    repris: b.repris?.length ?? 0,
    ids: [...b.traites, ...b.refuses, ...(b.repris ?? [])].join(",") || null,
    suspendu: b.suspendu === true,
  };
}

function aDuContenu(b: BilanReleve): boolean {
  return b.traites.length + b.refuses.length + b.ignores.length + b.invalides.length + (b.repris?.length ?? 0) > 0 || b.suspendu === true;
}

export function creerServiceVeilleur(deps: DepsService = {}): ServiceVeilleur {
  const dossier = deps.dossier ?? path.join(globalConfigRoot(), "veilleur");
  const cheminPoste = path.join(dossier, "poste.json");
  const lireConfig = deps.lireConfig ?? lireConfigVeilleur;
  const coffre = deps.etatCoffre ?? etatDuCoffre;
  const secrets = deps.secrets ?? readSecrets;
  const scelle = deps.scelle ?? coffreChiffreContient;
  const lireCa = deps.lireCa ?? ((c: string) => fsp.readFile(c, "utf8"));
  const fabrique =
    deps.client ??
    ((c: ConfigVeilleur, jeton: string, ca: string | undefined) =>
      creerClientBoite({ url: new URL(c.url), jeton, ca, env: c.proxy ? { ...process.env, HTTPS_PROXY: c.proxy } : process.env }));
  const etat = (deps.creerEtat ?? creerEtatFichier)(path.join(dossier, "etat.json"));
  const fils = deps.fils ?? creerMemoireFils(path.join(dossier, "fils.json"));
  const fabriqueLanceur =
    deps.lanceur ??
    ((cwd: string, config: ConfigVeilleur, journal: JournalVeilleur, f: MemoireFils, surBlocage: (motif: string) => void) =>
      creerLanceur({ cwd, config, journal, fils: f, surBlocage }));
  /** Ce qui n'a été dit qu'une fois au journal (message invalide, redépôt raté) ; vidé au changement d'état. */
  const dejaSignales = new Set<string>();
  const releve = deps.releve ?? uneReleve;
  const repeter = deps.repeter ?? repeterReel;
  const maintenant = deps.maintenant ?? Date.now;
  const nouvelId = deps.nouvelId ?? randomUUID;
  const notifier = deps.notifier ?? (() => {});
  const journal = deps.journal ?? journalParDefaut;

  let cwd: string | null = null;
  let enMarche = false;
  let etatCourant: EtatService = "inactif";
  let motif: string | undefined;
  let derniereReleve: string | undefined;
  let dernierBilan: BilanReleve | undefined;
  let signatureBilan = "";
  let releveEnCours: Promise<void> | null = null;
  let controleur: AbortController | null = null;
  let annulerRepetition: (() => void) | null = null;
  let cadenceCourante = 0;
  /** Tour interrompu mais vivant après le délai : état `bloque`, plus aucun tour jusqu'au redémarrage. */
  let bloqueMotif: string | null = null;

  function signalerBlocage(m: string): void {
    bloqueMotif = m;
    void passer("bloque", m);
  }

  async function statut(): Promise<StatutVeilleur> {
    let tours = 0;
    try {
      tours = await etat.toursAujourdhui();
    } catch {
      // État illisible : 0 affiché ; le battement le dit (état `invalide`).
    }
    return {
      etat: etatCourant,
      cwd,
      ...(motif ? { motif } : {}),
      ...(derniereReleve ? { derniereReleve } : {}),
      ...(dernierBilan ? { dernierBilan } : {}),
      toursAujourdhui: tours,
      enCours: releveEnCours !== null,
    };
  }

  async function pousser(): Promise<void> {
    try {
      notifier(await statut());
    } catch (e) {
      journal("warn", "statut du veilleur non poussé à l'interface", { cause: errMessage(e) });
    }
  }

  /** Transition d'état : journalisée et poussée une fois, pas à chaque battement. */
  async function passer(nouvel: EtatService, nouveauMotif?: string): Promise<void> {
    if (bloqueMotif !== null && nouvel !== "bloque") return; // bloqué : seul un redémarrage de l'application en sort
    if (nouvel === etatCourant && nouveauMotif === motif) return;
    etatCourant = nouvel;
    motif = nouveauMotif;
    dejaSignales.clear(); // nouvel état : ce qui a été tu une fois peut se redire
    journal(nouvel === "invalide" || nouvel === "suspendu" || nouvel === "bloque" ? "warn" : "info", `veilleur : ${nouvel}`, { cwd, motif: nouveauMotif ?? null });
    await pousser();
  }

  function armer(cadenceSec: number): void {
    if (!enMarche || (annulerRepetition && cadenceSec === cadenceCourante)) return;
    annulerRepetition?.();
    cadenceCourante = cadenceSec;
    annulerRepetition = repeter(() => void battement(), cadenceSec * 1000);
  }

  async function relever(projet: string, signal: AbortSignal): Promise<void> {
    const lu = await lireConfig(projet);
    if (signal.aborted) return;
    if ("absent" in lu) return passer("invalide", "config absente (.iaction/veilleur.json)");
    if ("invalide" in lu) return passer("invalide", `config invalide : ${lu.invalide}`);
    const config = lu.config;
    if (!config.actif) {
      couper();
      return passer("inactif", "désactivé dans la config du projet");
    }
    armer(config.cadenceSec);

    let suspension: { motif: string; le: string } | null;
    try {
      suspension = await etat.suspension();
    } catch (e) {
      return passer("invalide", errMessage(e));
    }
    if (suspension) return passer("suspendu", `${suspension.motif} (le ${suspension.le})`);
    if (coffre() !== "ouvert") return passer("en-attente-coffre", "coffre fermé : le veilleur reprend à son ouverture");
    // Scellé AVANT toute requête : une config non approuvée ne touche pas au réseau.
    const attendu = await scellePour(projet, config);
    if (!scelle(attendu.nom, attendu.empreinte)) return passer("invalide", MOTIF_SCELLE);

    const table = await secrets();
    const jeton = table[config.jetonSecret];
    if (!jeton) return passer("invalide", `secret « ${config.jetonSecret} » absent du coffre`);
    let ca: string | undefined;
    if (config.ca) {
      try {
        ca = await lireCa(path.resolve(projet, config.ca));
      } catch {
        return passer("invalide", `autorité de certification illisible : ${config.ca}`);
      }
    }
    let boite: ClientBoite;
    try {
      boite = fabrique(config, jeton, ca);
    } catch (e) {
      return passer("invalide", `client du relais : ${errMessage(e)}`);
    }
    if (signal.aborted) return; // arrêté pendant la préparation : aucune relève

    const recevoirPiece: RecevoirPiece = async (fil, nom, contenu) => {
      const r = await ecrireRecu(projet, fil, nom, contenu);
      return "refus" in r ? r : { chemin: r.relatif };
    };
    const bilan = await releve({
      boite,
      lancer: fabriqueLanceur(projet, config, journal, fils, signalerBlocage),
      etat,
      journal,
      config: { expediteurs: config.expediteurs, plafonds: config.plafonds },
      nouvelId,
      recevoirPiece,
      dejaSignales,
      valeursSecretes: async () => Object.values(await secrets()),
      signal,
    });
    derniereReleve = new Date(maintenant()).toISOString();
    dernierBilan = bilan;
    if (aDuContenu(bilan)) {
      // Un même bilan (une réponse qui attend en boîte) n'est dit qu'une fois.
      const signature = JSON.stringify({ ...bilan, erreur: undefined });
      if (signature !== signatureBilan) {
        signatureBilan = signature;
        journal("info", "relève", { cwd: projet, ...champsBilan(bilan) });
      }
      if (bilan.traites.length + bilan.refuses.length + (bilan.repris?.length ?? 0) > 0) await pousser();
    }
    if (signal.aborted) return; // l'arrêt décide de l'état
    if (bilan.suspendu) {
      const s = await etat.suspension().catch(() => null);
      return passer("suspendu", s ? `${s.motif} (le ${s.le})` : "coût dépassé");
    }
    // Liste en échec (jeton refusé, proxy, broker) ou état illisible : dit, puis retour à `actif` dès que ça repasse.
    if (bilan.erreur) return passer("invalide", bilan.erreur);
    await passer("actif");
  }

  async function battement(): Promise<void> {
    const projet = cwd;
    // Une relève en cours : ce battement saute. Bloqué : aucun nouveau tour.
    if (projet === null || !enMarche || releveEnCours || bloqueMotif !== null) return;
    // Contrôleur créé AVANT tout await : un arrêt pendant la préparation est vu.
    const ctrl = new AbortController();
    controleur = ctrl;
    const enCours = (async () => {
      try {
        await relever(projet, ctrl.signal);
      } catch (e) {
        // Aucun échec muet : la relève suivante réessaiera.
        journal("error", "battement du veilleur en échec", { cwd: projet, cause: errMessage(e) });
      }
    })();
    releveEnCours = enCours;
    try {
      await enCours;
    } finally {
      releveEnCours = null;
      if (controleur === ctrl) controleur = null;
    }
  }

  /** Arrête la boucle et interrompt le tour en cours (sa réponse « veilleur arrêté » part si possible). */
  function couper(): void {
    enMarche = false;
    annulerRepetition?.();
    annulerRepetition = null;
    cadenceCourante = 0;
    controleur?.abort();
  }

  async function ecrirePoste(projet: string): Promise<void> {
    await fsp.mkdir(dossier, { recursive: true });
    const tmp = `${cheminPoste}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ cwd: projet }), "utf8");
    await fsp.rename(tmp, cheminPoste);
  }

  async function demarrer(projet: string): Promise<StatutVeilleur> {
    if (cwd !== null && cwd !== projet && enMarche) await arreter();
    await ecrirePoste(projet);
    cwd = projet;
    enMarche = true;
    signatureBilan = "";
    if (etatCourant === "inactif" || etatCourant === "arret-en-cours") await passer("actif", undefined);
    armer(CADENCE_DEFAUT_SEC); // recalée sur la config au premier battement
    void battement();
    return statut();
  }

  async function arreter(): Promise<StatutVeilleur> {
    couper();
    const vivante = releveEnCours;
    if (vivante) {
      // Le tour interrompu doit rendre la main : jusque-là, l'état le dit.
      await passer("arret-en-cours", "interruption du tour en cours");
      void vivante.finally(() => {
        if (!enMarche) void passer("inactif", undefined);
      });
      return statut();
    }
    await passer("inactif", undefined);
    return statut();
  }

  async function demarrerAuLancement(): Promise<void> {
    let texte: string;
    try {
      texte = await fsp.readFile(cheminPoste, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // aucun veilleur sur ce poste
      await passer("invalide", `poste.json illisible : ${errMessage(e)}`);
      return;
    }
    let projet: unknown;
    try {
      projet = (JSON.parse(texte) as { cwd?: unknown }).cwd;
    } catch (e) {
      await passer("invalide", `poste.json corrompu : ${errMessage(e)}`);
      return;
    }
    if (typeof projet !== "string" || !projet) {
      await passer("invalide", "poste.json : « cwd » manquant");
      return;
    }
    cwd = projet;
    const lu = await lireConfig(projet);
    if (!("config" in lu)) {
      await passer("invalide", "absent" in lu ? "config absente (.iaction/veilleur.json)" : `config invalide : ${lu.invalide}`);
      return;
    }
    if (!lu.config.actif) return;
    journal("info", "veilleur redémarré au lancement", { cwd: projet });
    await demarrer(projet);
  }

  return {
    demarrer,
    arreter,
    statut,
    async lever() {
      await etat.lever();
      if (etatCourant === "suspendu") await passer("actif", undefined);
    },
    demarrerAuLancement,
    battement,
    async arreterPourSortir(borneMs: number) {
      const vivante = releveEnCours;
      couper();
      if (!vivante) return true;
      journal("info", "sortie du sidecar : arrêt du veilleur et du tour en cours", { cwd });
      let fini = false;
      let minuteur: NodeJS.Timeout | undefined;
      await Promise.race([vivante.then(() => void (fini = true)), new Promise<void>((r) => (minuteur = setTimeout(r, borneMs)))]);
      clearTimeout(minuteur);
      if (!fini) journal("error", "sortie du sidecar : le tour du veilleur n'a pas rendu la main à temps", { cwd, borneMs });
      return fini;
    },
    async oublierPoste(projetAussi = false) {
      await fsp.rm(cheminPoste, { force: true });
      // `veilleur.oublier` : la config n'existe plus, le statut ne la désigne plus.
      if (projetAussi && !enMarche) {
        cwd = null;
        await pousser();
      }
    },
  };
}
