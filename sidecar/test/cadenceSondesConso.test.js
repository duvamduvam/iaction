/*
 * T-086 — décisions temporelles PURES de la cadence des sondes coûteuses
 * (`usage.claude.init`, `usage.credits`), sans SDK ni process, sans réseau.
 *
 * Ce fichier ne couvre QUE les fonctions pures de `cadenceSondesConso.ts` :
 * la garde contre la vraie concurrence (deux appels avant la première
 * réponse) est un mécanisme à part, testé contre le VRAI code des handlers
 * dans `cadenceUsageCoalescee.test.js`.
 *
 * Lancement isolé : node sidecar/test/cadenceSondesConso.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const {
  CADENCE_SONDE_MS,
  SILENCE_DEFAUT_MS,
  REPRISE_BASE_MS,
  REPRISE_PLAFOND_MS,
  etatInitialInit,
  doitSonderInit,
  apresSondeInit,
  apresSaturationInit,
  etatInitialCredits,
  doitSonderCredits,
  apresSuccesCredits,
  apresEchecCredits,
  prochainDelaiReprise,
} = await import(moduleCompile("cadenceSondesConso.js"));

const T0 = 1_700_000_000_000;

await lancer(
  "T-086 — cadence des sondes coûteuses (fonctions pures)",

  async function init_premiere_sonde_toujours_autorisee() {
    assert(doitSonderInit(etatInitialInit(), T0), "aucune sonde connue : la première doit être autorisée");
    console.log("OK: usage.claude.init — première sonde toujours autorisée");
  },

  async function init_trop_tot_refuse() {
    const etat = apresSondeInit(T0);
    assert(!doitSonderInit(etat, T0 + CADENCE_SONDE_MS - 1), "juste avant la cadence : refusé");
    assert(doitSonderInit(etat, T0 + CADENCE_SONDE_MS), "à la cadence pile : autorisé");
    console.log("OK: usage.claude.init — cadence plate de 5 min respectée");
  },

  async function init_silence_bloque_meme_apres_la_cadence() {
    // T-059 — un refus daté à 18:00 arme le silence : même si la cadence de
    // 5 min est dépassée entre-temps, la sonde reste muette jusqu'à 18:00.
    const resetsAt = new Date(T0 + 3 * CADENCE_SONDE_MS).toISOString();
    const etat = apresSaturationInit(resetsAt, T0);
    assert(!doitSonderInit(etat, T0 + CADENCE_SONDE_MS), "silence actif : refusé malgré la cadence dépassée");
    assert(doitSonderInit(etat, T0 + 3 * CADENCE_SONDE_MS), "à l'échéance du silence : autorisé");
    console.log("OK: usage.claude.init — le silence de saturation prime sur la cadence");
  },

  async function init_silence_par_defaut_sans_heure_exploitable() {
    const etat = apresSaturationInit(null, T0);
    assert(!doitSonderInit(etat, T0 + SILENCE_DEFAUT_MS - 1), "silence par défaut : encore actif juste avant");
    assert(doitSonderInit(etat, T0 + SILENCE_DEFAUT_MS), "silence par défaut : levé à l'échéance");
    console.log("OK: usage.claude.init — silence par défaut (30 min) quand resetsAt est illisible");
  },

  async function init_resets_deja_passe_ne_recule_pas() {
    // Un refus qu'on VIENT de recevoir ne peut pas se réinitialiser avant
    // l'instant présent — sinon la sonde repartirait aussitôt sur un refus
    // dont l'issue est déjà connue.
    const etat = apresSaturationInit(new Date(T0 - 1000).toISOString(), T0);
    assert(!doitSonderInit(etat, T0 + 1), "resetsAt déjà passé : le silence par défaut s'applique quand même");
    console.log("OK: usage.claude.init — un resetsAt déjà passé n'annule pas le silence");
  },

  async function credits_premiere_sonde_toujours_autorisee() {
    assert(doitSonderCredits(etatInitialCredits(), T0), "aucun appel connu : le premier doit être autorisé");
    console.log("OK: usage.credits — premier appel toujours autorisé");
  },

  async function credits_succes_impose_la_cadence_stable() {
    const etat = apresSuccesCredits(T0);
    assert(etat.intervalleCourant === CADENCE_SONDE_MS, "un succès retombe sur la cadence stable");
    assert(etat.echecsConsecutifs === 0, "un succès remet les échecs consécutifs à zéro");
    assert(!doitSonderCredits(etat, T0 + CADENCE_SONDE_MS - 1), "trop tôt après un succès : refusé");
    assert(doitSonderCredits(etat, T0 + CADENCE_SONDE_MS), "à la cadence pile : autorisé");
    console.log("OK: usage.credits — un succès retombe sur la cadence stable de 5 min");
  },

  async function credits_echec_recule_puis_plafonne() {
    // 15 s, 30 s, 1 min, 2 min, 4 min, puis 5 min pour toujours (T-085).
    let etat = etatInitialCredits();
    const delais = [];
    for (let i = 0; i < 7; i++) {
      delais.push(prochainDelaiReprise(etat.echecsConsecutifs));
      etat = apresEchecCredits(etat, T0);
    }
    assert(
      delais[0] === REPRISE_BASE_MS && delais[1] === 30_000 && delais[2] === 60_000,
      `recul initial incorrect : ${JSON.stringify(delais)}`,
    );
    assert(
      delais[5] === REPRISE_PLAFOND_MS && delais[6] === REPRISE_PLAFOND_MS,
      `le recul doit plafonner à ${REPRISE_PLAFOND_MS}, reçu ${JSON.stringify(delais)}`,
    );
    console.log("OK: usage.credits — recul exponentiel puis plafond à 5 min");
  },

  async function credits_echec_puis_succes_efface_la_dette() {
    // Un incident bref ne doit laisser AUCUNE dette de recul (T-085) : le
    // premier succès qui suit repart sur la cadence stable, pas sur un recul
    // hérité des échecs précédents.
    let etat = etatInitialCredits();
    etat = apresEchecCredits(etat, T0);
    etat = apresEchecCredits(etat, T0 + 15_000);
    assert(etat.echecsConsecutifs === 2, "deux échecs consécutifs doivent être comptés");
    etat = apresSuccesCredits(T0 + 45_000);
    assert(etat.echecsConsecutifs === 0 && etat.intervalleCourant === CADENCE_SONDE_MS, "le succès efface la dette");
    console.log("OK: usage.credits — un succès efface la dette de recul d'un incident bref");
  },
);
