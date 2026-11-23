/*
 * Veilleur du relais — méthodes du protocole (docs/protocol.md § « Veilleur du
 * relais ») et service unique du sidecar.
 *
 * Le SCELLÉ : c'est l'ENREGISTREMENT par l'interface qui approuve une config.
 * `veilleur.configurer` écrit le fichier ET range son empreinte au coffre
 * (secret `veilleur.empreinte.<projet>`, un par projet) ; le service et les
 * outils `relais_*` refusent toute config dont l'empreinte ne correspond pas.
 * Ces méthodes ne sont joignables que par le protocole (stdin du sidecar,
 * tenu par la coquille) : aucun outil d'agent n'écrit ni la config ni le scellé.
 *
 *   veilleur.statut {}                → done StatutVeilleur
 *   veilleur.lire {cwd}               → done {config, scellee} | {absent: true} | {invalide}
 *   veilleur.configurer {cwd, config} → coffre ouvert exigé ; scelle puis écrit → done {config}
 *   veilleur.activer {cwd}            → exige une config scellée ; pose `actif: true`
 *                                       (re-scellé), mémorise le poste, lève une
 *                                       suspension, démarre → done statut
 *   veilleur.desactiver {}            → arrête, pose `actif: false` (re-scellé),
 *                                       oublie le poste → done statut
 *   veilleur.oublier {cwd}            → coffre ouvert exigé ; supprime la config
 *                                       et son scellé → done statut
 *
 * Événement non sollicité `veilleur` (sans `id`, comme `ready`) à chaque
 * changement d'état : la charge est le statut. Le jeton n'y figure jamais.
 */

import path from "node:path";

import { errMessage, isNonEmptyString } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import { coffreChiffreContient, deleteSecret, etatDuCoffre, setSecret } from "./mcpSecrets.js";
import {
  champsDifferents,
  cheminReelProjet,
  ecrireConfigVeilleur,
  exclureDeGit,
  lireApprouvee,
  lireConfigScellee,
  memoriserApprouvee,
  oublierApprouvee,
  MOTIF_SCELLE,
  nomScelle,
  scellePour,
  supprimerConfigVeilleur,
  validerConfig,
  type ConfigVeilleur,
} from "./veilleurConfig.js";
import { creerServiceVeilleur, type ServiceVeilleur, type StatutVeilleur } from "./veilleurService.js";

let notifier: (s: StatutVeilleur) => void = () => {};
let service: ServiceVeilleur | null = null;

const MESSAGE_COFFRE_FERME = "coffre fermé : déverrouille-le — l'approbation de la config du veilleur est rangée au coffre";

/** Canal de l'événement `veilleur` (posé par index.ts). */
export function definirNotificationVeilleur(f: (s: StatutVeilleur) => void): void {
  notifier = f;
}

function leService(): ServiceVeilleur {
  service ??= creerServiceVeilleur({ notifier: (s) => notifier(s) });
  return service;
}

/** Lancement du sidecar : le veilleur du poste repart seul si sa config le dit. */
export async function demarrerVeilleurAuLancement(): Promise<void> {
  try {
    await leService().demarrerAuLancement();
  } catch (e) {
    journal.error("relais", "veilleur : redémarrage au lancement impossible", { fields: { erreur: errMessage(e) } });
  }
}

/** Fermeture de l'entrée standard : le veilleur s'arrête et son tour s'interrompt, borné. Ne lève jamais. */
export async function arreterVeilleurPourSortir(borneMs = 10_000): Promise<void> {
  if (!service) return; // jamais servi : rien à arrêter
  try {
    await service.arreterPourSortir(borneMs);
  } catch (e) {
    journal.error("relais", "veilleur : arrêt à la sortie en échec", { fields: { erreur: errMessage(e) } });
  }
}

function cwdValide(params: Record<string, unknown>, id: string, emitter: EngineEmitter): string | null {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd) || !path.isAbsolute(cwd)) {
    emitter.error(id, "params.cwd : chemin absolu du projet attendu");
    return null;
  }
  return cwd;
}

/**
 * Scelle (empreinte au coffre, `done` après l'accusé de la coquille) PUIS
 * écrit. Un scellé raté n'écrit rien ; une écriture ratée après le scellé
 * laisse un fichier non approuvé (refusé partout), jamais l'inverse.
 */
async function scellerEtEcrire(cwd: string, config: ConfigVeilleur): Promise<ConfigVeilleur> {
  const { nom, empreinte } = await scellePour(cwd, config);
  await setSecret(nom, empreinte);
  const r = await ecrireConfigVeilleur(cwd, config);
  if ("invalide" in r) throw new Error(`config du veilleur refusée : ${r.invalide}`);
  // Copie indicative (montrer ce qui a changé un jour) : son échec n'invalide rien.
  await memoriserApprouvee(cwd, r.config).catch((e: unknown) =>
    journal.warn("relais", "copie de la config approuvée non écrite", { fields: { cwd, erreur: errMessage(e) } }),
  );
  return r.config;
}

export async function handleVeilleurStatut(id: string, emitter: EngineEmitter): Promise<void> {
  emitter.done(id, { ...(await leService().statut()) });
}

/** `scellee` : `true`/`false` coffre ouvert, `null` coffre fermé (impossible à vérifier). */
export async function handleVeilleurLire(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const cwd = cwdValide(params, id, emitter);
  if (!cwd) return;
  const lu = await lireConfigScellee(cwd, coffreChiffreContient);
  if (!("config" in lu)) {
    emitter.done(id, { ...lu });
    return;
  }
  const scellee = etatDuCoffre() === "ouvert" ? lu.scellee : null;
  // Non approuvée : la dernière version approuvée (si connue) et ce qui en diffère, pour que l'interface le MONTRE.
  const approuvee = scellee === false ? await lireApprouvee(cwd) : null;
  emitter.done(id, {
    config: lu.config,
    scellee,
    ...(scellee === false ? { approuvee, differences: approuvee ? champsDifferents(approuvee, lu.config) : null } : {}),
  });
}

/** Enregistrer = APPROUVER pour ce poste : coffre ouvert exigé, sinon rien n'est écrit. */
export async function handleVeilleurConfigurer(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const cwd = cwdValide(params, id, emitter);
  if (!cwd) return;
  const v = validerConfig(params.config);
  if ("invalide" in v) {
    emitter.error(id, `config du veilleur refusée : ${v.invalide}`);
    return;
  }
  // Coffre OUVERT exigé : fermé ou absent, setSecret irait dans l'ancien fichier en clair.
  if (etatDuCoffre() !== "ouvert") {
    emitter.error(id, `${MESSAGE_COFFRE_FERME} ; rien n'est enregistré`);
    return;
  }
  let config: ConfigVeilleur;
  try {
    config = await scellerEtEcrire(cwd, v.config);
  } catch (e) {
    emitter.error(id, `enregistrement impossible : ${errMessage(e)}`);
    return;
  }
  journal.info("relais", "config du veilleur enregistrée et approuvée (scellée au coffre)", { fields: { cwd, actif: config.actif, bash: config.bash } });
  // Ni la config ni les fichiers reçus ne doivent partir dans un commit : exclusion LOCALE seulement.
  const avertissement = await exclureDeGit(cwd);
  if (avertissement) journal.warn("relais", avertissement, { fields: { cwd } });
  emitter.done(id, { config, ...(avertissement ? { avertissement } : {}) });
}

/** Pourquoi l'activation est refusée dans cet état du service (pure, testée), ou `null`. */
export function refusActivation(etat: StatutVeilleur["etat"]): string | null {
  if (etat === "arret-en-cours") return "un arrêt est en cours (le tour interrompu n'a pas encore rendu la main) : attends la fin de l'arrêt";
  if (etat === "bloque") return "un tour du veilleur est bloqué après son interruption : relance l'application";
  return null;
}

/** Activer : une config SCELLÉE seulement ; `actif: true` posé et re-scellé (changement fait par le sidecar). */
export async function handleVeilleurActiver(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const cwd = cwdValide(params, id, emitter);
  if (!cwd) return;
  if (etatDuCoffre() !== "ouvert") {
    emitter.error(id, MESSAGE_COFFRE_FERME);
    return;
  }
  const refus = refusActivation((await leService().statut()).etat);
  if (refus) {
    emitter.error(id, refus);
    return;
  }
  const lu = await lireConfigScellee(cwd, coffreChiffreContient);
  if (!("config" in lu)) {
    emitter.error(id, "absent" in lu ? "aucune config de veilleur dans ce projet : enregistre-la d'abord" : `config du veilleur invalide : ${lu.invalide}`);
    return;
  }
  if (!lu.scellee) {
    emitter.error(id, MOTIF_SCELLE);
    return;
  }
  if (!lu.config.actif) {
    try {
      await scellerEtEcrire(cwd, { ...lu.config, actif: true });
    } catch (e) {
      emitter.error(id, `activation impossible : ${errMessage(e)}`);
      return;
    }
  }
  const s = leService();
  await s.lever();
  emitter.done(id, { ...(await s.demarrer(cwd)) });
}

/**
 * Désactiver : arrêt (le tour en cours s'interrompt : `arret-en-cours`), poste
 * oublié (pas de redémarrage au lancement), `actif: false` posé et re-scellé
 * — sinon la config deviendrait invalide pour les outils. Une config non
 * approuvée n'est PAS re-scellée (ce serait l'approuver) : c'est dit.
 */
export async function handleVeilleurDesactiver(id: string, emitter: EngineEmitter): Promise<void> {
  const s = leService();
  const { cwd } = await s.statut();
  const statut = await s.arreter();
  const avertissements: string[] = [];
  try {
    await s.oublierPoste();
  } catch (e) {
    avertissements.push(`poste non oublié (${errMessage(e)})`);
  }
  if (cwd) {
    if (etatDuCoffre() !== "ouvert") {
      avertissements.push("coffre fermé : actif:false non posé (la config reste approuvée telle quelle)");
    } else {
      const lu = await lireConfigScellee(cwd, coffreChiffreContient);
      if ("config" in lu && !lu.scellee) {
        avertissements.push("config modifiée hors de l'interface : non re-scellée, ré-enregistre-la dans la section Veilleur");
      } else if ("config" in lu && lu.config.actif) {
        try {
          await scellerEtEcrire(cwd, { ...lu.config, actif: false });
        } catch (e) {
          avertissements.push(`actif:false non posé (${errMessage(e)})`);
        }
      }
    }
  }
  if (avertissements.length > 0) journal.warn("relais", "veilleur désactivé, avec réserves", { fields: { cwd, avertissements: avertissements.join(" ; ") } });
  emitter.done(id, { ...statut, ...(avertissements.length > 0 ? { avertissement: avertissements.join(" ; ") } : {}) });
}

/** Oublier : la config du projet et son scellé disparaissent ; le veilleur du poste s'arrête s'il était celui-ci. */
export async function handleVeilleurOublier(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const cwd = cwdValide(params, id, emitter);
  if (!cwd) return;
  if (etatDuCoffre() !== "ouvert") {
    emitter.error(id, `${MESSAGE_COFFRE_FERME} ; rien n'est supprimé`);
    return;
  }
  const s = leService();
  const memeProjet = (await s.statut()).cwd === cwd;
  if (memeProjet) await s.arreter();
  try {
    await deleteSecret(nomScelle(await cheminReelProjet(cwd)));
    await supprimerConfigVeilleur(cwd);
    await oublierApprouvee(cwd);
    if (memeProjet) await s.oublierPoste(true);
  } catch (e) {
    emitter.error(id, `suppression incomplète : ${errMessage(e)}`);
    return;
  }
  journal.info("relais", "config du veilleur et son scellé supprimés", { fields: { cwd } });
  emitter.done(id, { oublie: true, ...(await s.statut()) });
}
