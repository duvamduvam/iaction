#!/usr/bin/env node
/**
 * ia-runner — planification : lit les manifestes `tache.yaml` SYNCHRONISÉS et
 * écrit sur stdout un crontab à 5 champs pour supercronic (tranche D1 de
 * docs/etude-remote.md § 4).
 *
 * Deux différences structurantes avec le poste (`sidecar/src/tachesTimers.ts`) :
 *
 * 1. La racine des tâches n'est PAS la config globale de la machine
 *    (`~/.config/net.duvam.iaction/taches`, non synchronisée) mais un dossier
 *    dédié et synchronisé, donné par `IA_RUNNER_TACHES_DIR`.
 * 2. Le manifeste porte un champ facultatif `lieu: local|serveur` (défaut
 *    `local`). Le serveur n'exécute QUE `lieu: serveur` : c'est le garde-fou
 *    anti-double-déclenchement de l'étude (§ 10, phase D3 — « jamais les deux
 *    armés »). Une tâche laissée en `local` est donc ignorée ici, et ce n'est
 *    pas un échec.
 *
 * Conversion `OnCalendar` (systemd) → cron 5 champs : cron n'a ni seconde, ni
 * année, et combine jour-du-mois/jour-de-semaine par OU là où systemd les
 * combine par ET. Toute forme qui ne se traduit pas FIDÈLEMENT est REFUSÉE
 * avec un message nommant la tâche et la valeur — jamais une exclusion
 * silencieuse ni, pire, une conversion approximative qui ferait tourner la
 * tâche à la mauvaise heure (principe « aucun échec muet », docs/etude-logs.md).
 *
 * Ce module est aussi la boîte à outils partagée du runner (lecture des
 * manifestes, notification ntfy) : le contrat d'interface de D1 fige la liste
 * des fichiers de `bin/`, on n'ajoute donc pas de module utilitaire à côté —
 * `run-tache.mjs` importe d'ici.
 *
 * Usage : node plan-cron.mjs [--racine <dossier>]
 * Sortie : crontab sur stdout ; erreurs sur stderr ; code 1 si au moins une
 * tâche a été refusée (l'appelant garde les lignes valides : voir entrypoint.sh).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const DOSSIER_BIN = path.dirname(fileURLToPath(import.meta.url));

/** Chemin de `run-tache.mjs`, voisin de ce fichier (le dépôt est copié en /app). */
export function cheminRunTache() {
  return path.join(DOSSIER_BIN, "run-tache.mjs");
}

/** Racine des tâches synchronisées — relue à chaque appel, jamais mise en cache. */
export function racineTaches() {
  const v = process.env.IA_RUNNER_TACHES_DIR;
  return typeof v === "string" && v.length > 0 ? v : "/data/taches";
}

/** Racine des projets synchronisés (liste blanche), voir docs/etude-remote.md § 2. */
export function racineProjets() {
  const v = process.env.IA_RUNNER_PROJETS_DIR;
  return typeof v === "string" && v.length > 0 ? v : "/data/projets";
}

/** Zone d'état, EXCLUSIVEMENT écrite par le serveur (règle d'or § 3 de l'étude). */
export function racineEtat() {
  const v = process.env.IA_RUNNER_ETAT_DIR;
  return typeof v === "string" && v.length > 0 ? v : "/data/etat";
}

// ---------------------------------------------------------------------------
// Petits utilitaires (dupliqués depuis sidecar/src/taches.ts, qui ne les
// exporte pas — même convention que taches.ts vis-à-vis d'orchestrator.ts).
// ---------------------------------------------------------------------------

function estChaineNonVide(v) {
  return typeof v === "string" && v.length > 0;
}

function estObjet(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function messageErreur(err) {
  return err instanceof Error ? err.message : String(err);
}

const NOM_RE = /^[a-z0-9-]{1,64}$/;

// ---------------------------------------------------------------------------
// Notification ntfy — échecs seulement (docs/etude-remote.md § 7)
// ---------------------------------------------------------------------------

/**
 * En-tête HTTP `Title` : les en-têtes ne transportent pas d'UTF-8 de façon
 * fiable (fetch rejette les caractères hors latin-1). Tout le projet étant en
 * français, on translittère plutôt que de risquer un envoi qui échoue au
 * moment où l'on veut justement être prévenu. Le CORPS, lui, reste en UTF-8.
 */
function sansAccents(texte) {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");
}

/**
 * Notifie ntfy. `NTFY_URL`/`NTFY_TOPIC` absents = notification désactivée
 * (retour `false`, aucun bruit) : c'est une configuration légitime, pas une
 * panne. En revanche un ENVOI qui échoue est tracé sur stderr — sinon la
 * notification d'échec échouerait elle-même en silence.
 */
export async function notifierNtfy(titre, message) {
  const base = process.env.NTFY_URL;
  const sujet = process.env.NTFY_TOPIC;
  if (!estChaineNonVide(base) || !estChaineNonVide(sujet)) {
    return false;
  }
  const cible = `${base.replace(/\/+$/, "")}/${sujet}`;
  try {
    const reponse = await fetch(cible, {
      method: "POST",
      headers: {
        Title: sansAccents(titre).slice(0, 200),
        Priority: "high",
        Tags: "rotating_light",
      },
      body: message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!reponse.ok) {
      process.stderr.write(`[ia-runner] ntfy a répondu ${reponse.status} (${cible})\n`);
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(`[ia-runner] notification ntfy impossible (${cible}) : ${messageErreur(err)}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manifeste `tache.yaml`
// ---------------------------------------------------------------------------

/**
 * Normalisation du manifeste — sur-ensemble de `normalizeTache`
 * (sidecar/src/taches.ts) avec les trois champs propres au serveur :
 *
 * - `lieu` : `local` (défaut) | `serveur` ;
 * - `projet` : nom de dossier sous `IA_RUNNER_PROJETS_DIR`, PRIORITAIRE sur
 *   `cwd` (qui porte un chemin absolu du poste, inexistant ici) ;
 * - `timeoutMinutes` : plafond d'exécution, défaut 30 (docs/etude-remote.md § 4).
 *
 * Les champs inconnus sont ignorés, comme côté sidecar : un manifeste écrit par
 * le serveur reste lisible par l'app, et réciproquement.
 */
export function normaliserManifeste(brut) {
  if (!estObjet(brut)) {
    return { ok: false, message: "le contenu doit être un objet YAML (mapping clé/valeur)" };
  }

  const nom = brut.name;
  if (!estChaineNonVide(nom) || !NOM_RE.test(nom)) {
    return { ok: false, message: `champ 'name' invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nom)}` };
  }

  const orchestration = brut.orchestration;
  if (!estChaineNonVide(orchestration) || !NOM_RE.test(orchestration)) {
    return {
      ok: false,
      message: `champ 'orchestration' invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(orchestration)}`,
    };
  }

  let schedule = null;
  if (brut.schedule !== undefined && brut.schedule !== null) {
    if (!estChaineNonVide(brut.schedule)) {
      return { ok: false, message: "champ 'schedule' doit être une chaîne non vide, ou absent/null" };
    }
    schedule = brut.schedule;
  }

  const inputs = {};
  if (brut.inputs !== undefined && brut.inputs !== null) {
    if (!estObjet(brut.inputs)) {
      return { ok: false, message: "champ 'inputs' doit être un objet {clef: chaîne}" };
    }
    for (const [k, v] of Object.entries(brut.inputs)) {
      if (typeof v !== "string") {
        return { ok: false, message: `champ 'inputs.${k}' doit être une chaîne` };
      }
      inputs[k] = v;
    }
  }

  let report = null;
  if (brut.report !== undefined && brut.report !== null) {
    if (!estChaineNonVide(brut.report)) {
      return { ok: false, message: "champ 'report' doit être une chaîne non vide, ou absent/null" };
    }
    if (path.isAbsolute(brut.report) || brut.report.split(/[\\/]+/).includes("..")) {
      return {
        ok: false,
        message: `champ 'report' doit être un chemin relatif au dossier de la tâche, sans '..': ${brut.report}`,
      };
    }
    report = brut.report;
  }

  let enabled = false;
  if (brut.enabled !== undefined && brut.enabled !== null) {
    if (typeof brut.enabled !== "boolean") {
      return { ok: false, message: "champ 'enabled' doit être un booléen" };
    }
    enabled = brut.enabled;
  }

  let cwd = null;
  if (brut.cwd !== undefined && brut.cwd !== null) {
    if (!estChaineNonVide(brut.cwd)) {
      return { ok: false, message: "champ 'cwd' doit être une chaîne non vide, ou absent/null" };
    }
    cwd = brut.cwd;
  }

  let lieu = "local";
  if (brut.lieu !== undefined && brut.lieu !== null) {
    if (brut.lieu !== "local" && brut.lieu !== "serveur") {
      return { ok: false, message: `champ 'lieu' doit valoir 'local' ou 'serveur', reçu: ${JSON.stringify(brut.lieu)}` };
    }
    lieu = brut.lieu;
  }

  let projet = null;
  if (brut.projet !== undefined && brut.projet !== null) {
    if (!estChaineNonVide(brut.projet) || brut.projet.includes("/") || brut.projet === "..") {
      return {
        ok: false,
        message: `champ 'projet' doit être un NOM de dossier (sans séparateur de chemin), reçu: ${JSON.stringify(brut.projet)}`,
      };
    }
    projet = brut.projet;
  }

  let timeoutMinutes = 30;
  if (brut.timeoutMinutes !== undefined && brut.timeoutMinutes !== null) {
    if (typeof brut.timeoutMinutes !== "number" || !Number.isFinite(brut.timeoutMinutes) || brut.timeoutMinutes <= 0) {
      return {
        ok: false,
        message: `champ 'timeoutMinutes' doit être un nombre de minutes > 0, reçu: ${JSON.stringify(brut.timeoutMinutes)}`,
      };
    }
    timeoutMinutes = brut.timeoutMinutes;
  }

  return {
    ok: true,
    tache: { name: nom, orchestration, schedule, inputs, report, enabled, cwd, lieu, projet, timeoutMinutes },
  };
}

/**
 * Lit `<racine>/<nom>/tache.yaml`. Comme `taches.list` côté sidecar, une tâche
 * illisible n'est jamais escamotée : elle revient avec `erreur` renseignée pour
 * que l'appelant la signale.
 */
export async function lireManifeste(racine, nom) {
  const dossier = path.join(racine, nom);
  const chemin = path.join(dossier, "tache.yaml");
  let contenu;
  try {
    contenu = await fsp.readFile(chemin, "utf8");
  } catch (err) {
    return { nom, dossier, tache: null, erreur: `lecture impossible de ${chemin}: ${messageErreur(err)}` };
  }
  let analyse;
  try {
    analyse = parseYaml(contenu);
  } catch (err) {
    return { nom, dossier, tache: null, erreur: `YAML invalide (${chemin}): ${messageErreur(err)}` };
  }
  const resultat = normaliserManifeste(analyse);
  if (!resultat.ok) {
    return { nom, dossier, tache: null, erreur: `${resultat.message} (${chemin})` };
  }
  if (resultat.tache.name !== nom) {
    return {
      nom,
      dossier,
      tache: null,
      erreur: `champ 'name' ('${resultat.tache.name}') différent du nom du dossier ('${nom}')`,
    };
  }
  return { nom, dossier, tache: resultat.tache, erreur: null };
}

/** Tous les sous-dossiers de `racine` contenant un `tache.yaml`, triés par nom. */
export async function listerManifestes(racine) {
  let entrees;
  try {
    entrees = await fsp.readdir(racine, { withFileTypes: true });
  } catch (err) {
    // Racine absente = anomalie de synchro, pas un « aucune tâche » anodin.
    throw new Error(`racine des tâches illisible (${racine}): ${messageErreur(err)}`);
  }
  const noms = [];
  for (const e of entrees) {
    if (!e.isDirectory()) continue;
    try {
      await fsp.access(path.join(racine, e.name, "tache.yaml"));
      noms.push(e.name);
    } catch {
      // Pas de tache.yaml : ce dossier n'est pas une tâche déclarée (ex. la
      // zone d'état remontée par sync-up.sh). Rien à signaler.
    }
  }
  noms.sort((a, b) => a.localeCompare(b));
  const resultats = [];
  for (const nom of noms) {
    resultats.push(await lireManifeste(racine, nom));
  }
  return resultats;
}

// ---------------------------------------------------------------------------
// OnCalendar (systemd.time) → cron 5 champs
// ---------------------------------------------------------------------------

/** Raccourcis systemd, développés en leur forme normalisée (systemd.time(7)). */
const RACCOURCIS = {
  minutely: "*-*-* *:*:00",
  hourly: "*-*-* *:00:00",
  daily: "*-*-* 00:00:00",
  weekly: "Mon *-*-* 00:00:00",
  monthly: "*-*-01 00:00:00",
  quarterly: "*-01,04,07,10-01 00:00:00",
  semiannually: "*-01,07-01 00:00:00",
  yearly: "*-01-01 00:00:00",
  annually: "*-01-01 00:00:00",
};

const JOURS = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 0,
  sunday: 0,
};

function echec(message) {
  return { ok: false, message };
}

function entierValide(texte, min, max) {
  if (!/^\d{1,4}$/.test(texte)) {
    return null;
  }
  const n = Number(texte);
  if (!Number.isInteger(n) || n < min || n > max) {
    return null;
  }
  return n;
}

/**
 * Convertit UN champ systemd (`*`, `5`, `1..5`, `*\/10`, `0..30/5`, listes
 * séparées par des virgules) en champ cron. Les valeurs numériques sont
 * renormalisées (`08` → `8`) : `08`/`09` sont des pièges classiques des
 * implémentations qui liraient de l'octal.
 */
function convertirChamp(spec, min, max, nomChamp) {
  const morceaux = spec.split(",");
  const sortie = [];
  for (const morceauBrut of morceaux) {
    const morceau = morceauBrut.trim();
    if (morceau.length === 0) {
      return echec(`champ ${nomChamp} : élément vide dans « ${spec} »`);
    }
    if (/[~ ]/.test(morceau)) {
      return echec(`champ ${nomChamp} : « ${morceau} » utilise une syntaxe systemd sans équivalent cron`);
    }

    let base = morceau;
    let pas = null;
    const barre = morceau.indexOf("/");
    if (barre >= 0) {
      base = morceau.slice(0, barre);
      const texte = morceau.slice(barre + 1);
      pas = entierValide(texte, 1, max);
      if (pas === null) {
        return echec(`champ ${nomChamp} : pas de répétition invalide dans « ${morceau} »`);
      }
    }

    if (base === "*") {
      sortie.push(pas === null ? "*" : `*/${pas}`);
      continue;
    }

    const points = base.indexOf("..");
    if (points >= 0) {
      const debut = entierValide(base.slice(0, points), min, max);
      const fin = entierValide(base.slice(points + 2), min, max);
      if (debut === null || fin === null) {
        return echec(`champ ${nomChamp} : intervalle « ${base} » hors bornes ${min}..${max} ou mal formé`);
      }
      if (debut > fin) {
        // systemd n'accepte pas non plus les intervalles décroissants, mais
        // cron les accepte parfois en « bouclant » : refus explicite.
        return echec(`champ ${nomChamp} : intervalle décroissant « ${base} »`);
      }
      sortie.push(pas === null ? `${debut}-${fin}` : `${debut}-${fin}/${pas}`);
      continue;
    }

    const valeur = entierValide(base, min, max);
    if (valeur === null) {
      return echec(`champ ${nomChamp} : valeur « ${base} » hors bornes ${min}..${max} ou mal formée`);
    }
    // `N/pas` en systemd = « à partir de N, tous les pas » : cron l'écrit `N-max/pas`.
    sortie.push(pas === null ? String(valeur) : `${valeur}-${max}/${pas}`);
  }
  return { ok: true, champ: sortie.join(",") };
}

/** Jours de semaine : systemd n'accepte que les noms ; cron veut 0..6 (dim = 0). */
function convertirJoursSemaine(spec) {
  const morceaux = spec.split(",");
  const sortie = [];
  for (const morceauBrut of morceaux) {
    const morceau = morceauBrut.trim().toLowerCase();
    if (morceau.length === 0) {
      return echec(`jour de semaine : élément vide dans « ${spec} »`);
    }
    const points = morceau.indexOf("..");
    if (points >= 0) {
      const debut = JOURS[morceau.slice(0, points)];
      const fin = JOURS[morceau.slice(points + 2)];
      if (debut === undefined || fin === undefined) {
        return echec(`jour de semaine : intervalle « ${morceau} » non reconnu (attendu Mon..Fri)`);
      }
      if (debut > fin) {
        // Ex. `Fri..Mon` : systemd boucle sur la semaine, cron non.
        return echec(`jour de semaine : intervalle « ${morceau} » traverse le dimanche, sans équivalent cron`);
      }
      sortie.push(debut === fin ? String(debut) : `${debut}-${fin}`);
      continue;
    }
    const jour = JOURS[morceau];
    if (jour === undefined) {
      return echec(`jour de semaine : « ${morceau} » non reconnu (attendu Mon, Tue, ... ou Monday, ...)`);
    }
    sortie.push(String(jour));
  }
  return { ok: true, champ: sortie.join(",") };
}

/**
 * `OnCalendar` → `{ok:true, cron:"m h dom mon dow"}` ou `{ok:false, message}`.
 *
 * Refus assumés (mieux vaut une tâche non planifiée et signalée qu'une tâche
 * planifiée à côté de l'heure demandée) :
 * - secondes non nulles : cron ne descend pas sous la minute ;
 * - année explicite : cron n'a pas de champ année ;
 * - jour-du-mois ET jour-de-semaine tous deux restreints : systemd les combine
 *   par ET, cron par OU — la conversion changerait le sens ;
 * - suffixe de fuseau horaire : le conteneur impose son TZ, un fuseau par
 *   tâche n'est pas représentable.
 */
export function convertirOnCalendarEnCron(valeur) {
  if (!estChaineNonVide(valeur) || valeur.trim().length === 0) {
    return echec("schedule vide");
  }
  const brut = valeur.trim();
  const raccourci = RACCOURCIS[brut.toLowerCase()];
  // Un mot seul est soit un raccourci (`daily`), soit un jour de semaine
  // (`Mon`, qui vaut `Mon *-*-* 00:00:00`). Tout autre mot est une faute de
  // frappe : refus nommant les raccourcis connus plutôt qu'une planification
  // inventée.
  if (raccourci === undefined && /^[a-z]+$/i.test(brut) && JOURS[brut.toLowerCase()] === undefined) {
    return echec(`raccourci « ${brut} » inconnu (attendus: ${Object.keys(RACCOURCIS).join(", ")})`);
  }
  // Les listes systemd tolèrent une espace après la virgule (`Mon, Fri`) : on
  // la retire AVANT le découpage en jetons, sinon le jour de semaine se
  // retrouverait éclaté sur deux jetons.
  const normalise = (raccourci ?? brut).replace(/,\s+/g, ",");
  const jetons = normalise.split(/\s+/).filter((j) => j.length > 0);

  let specJours = null;
  if (jetons.length > 0 && /[a-z]/i.test(jetons[0])) {
    specJours = jetons.shift();
  }

  let specDate = null;
  let specHeure = null;
  if (jetons.length === 2) {
    [specDate, specHeure] = jetons;
  } else if (jetons.length === 1) {
    if (jetons[0].includes(":")) {
      specHeure = jetons[0];
    } else {
      specDate = jetons[0];
    }
  } else if (jetons.length > 2) {
    return echec(
      `forme « ${brut} » non convertible : jetons en trop (fuseau horaire ou suffixe non pris en charge)`,
    );
  }

  // Défauts systemd : date absente = *-*-*, heure absente = 00:00:00.
  const partiesDate = (specDate ?? "*-*-*").split("-");
  let specAnnee = "*";
  let specMois;
  let specJour;
  if (partiesDate.length === 3) {
    [specAnnee, specMois, specJour] = partiesDate;
  } else if (partiesDate.length === 2) {
    [specMois, specJour] = partiesDate;
  } else {
    return echec(`date « ${specDate} » non reconnue (attendu AAAA-MM-JJ ou MM-JJ)`);
  }
  if (specAnnee !== "*") {
    return echec(`année « ${specAnnee} » : cron n'a pas de champ année, planification non convertible`);
  }

  const partiesHeure = (specHeure ?? "00:00:00").split(":");
  let specSecondes = "0";
  let specH;
  let specM;
  if (partiesHeure.length === 3) {
    [specH, specM, specSecondes] = partiesHeure;
  } else if (partiesHeure.length === 2) {
    [specH, specM] = partiesHeure;
  } else {
    return echec(`heure « ${specHeure} » non reconnue (attendu HH:MM ou HH:MM:SS)`);
  }
  if (!/^0+$/.test(specSecondes.trim())) {
    return echec(
      `secondes « ${specSecondes} » : cron ne descend pas sous la minute, seul :00 est convertible`,
    );
  }

  const minute = convertirChamp(specM, 0, 59, "minute");
  if (!minute.ok) return minute;
  const heure = convertirChamp(specH, 0, 23, "heure");
  if (!heure.ok) return heure;
  const jourDuMois = convertirChamp(specJour, 1, 31, "jour du mois");
  if (!jourDuMois.ok) return jourDuMois;
  const mois = convertirChamp(specMois, 1, 12, "mois");
  if (!mois.ok) return mois;

  let jourSemaine = { ok: true, champ: "*" };
  if (specJours !== null) {
    jourSemaine = convertirJoursSemaine(specJours);
    if (!jourSemaine.ok) return jourSemaine;
  }

  if (jourDuMois.champ !== "*" && jourSemaine.champ !== "*") {
    return echec(
      `« ${brut} » restreint à la fois le jour du mois (${jourDuMois.champ}) et le jour de semaine (${jourSemaine.champ}) : ` +
        "systemd les combine par ET, cron par OU — la conversion changerait le sens",
    );
  }

  return {
    ok: true,
    cron: [minute.champ, heure.champ, jourDuMois.champ, mois.champ, jourSemaine.champ].join(" "),
  };
}

// ---------------------------------------------------------------------------
// Construction du crontab
// ---------------------------------------------------------------------------

/**
 * Parcourt la racine et renvoie `{lignes, erreurs, ignorees}` :
 * - `lignes` : entrées de crontab prêtes pour supercronic ;
 * - `erreurs` : messages destinés à stderr + ntfy (aucun refus muet) ;
 * - `ignorees` : tâches valides mais non concernées (`enabled: false` ou
 *   `lieu: local`) — information, pas anomalie.
 */
export async function construireCrontab(racine, options = {}) {
  const noeud = options.node ?? process.execPath;
  const script = options.runTache ?? cheminRunTache();
  const manifestes = await listerManifestes(racine);

  const lignes = [];
  const erreurs = [];
  const ignorees = [];

  for (const entree of manifestes) {
    if (entree.erreur) {
      erreurs.push(`tâche '${entree.nom}' : ${entree.erreur}`);
      continue;
    }
    const t = entree.tache;
    if (t.lieu !== "serveur") {
      ignorees.push(`${t.name} (lieu: ${t.lieu})`);
      continue;
    }
    if (!t.enabled) {
      ignorees.push(`${t.name} (enabled: false)`);
      continue;
    }
    if (!estChaineNonVide(t.schedule)) {
      erreurs.push(`tâche '${t.name}' : 'lieu: serveur' et 'enabled: true' mais aucun 'schedule' — rien à planifier`);
      continue;
    }
    const conversion = convertirOnCalendarEnCron(t.schedule);
    if (!conversion.ok) {
      erreurs.push(`tâche '${t.name}' : schedule « ${t.schedule} » non convertible en cron — ${conversion.message}`);
      continue;
    }
    lignes.push(`${conversion.cron} ${noeud} ${script} ${t.name}`);
  }

  return { lignes, erreurs, ignorees };
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

async function principal(argv) {
  let racine = racineTaches();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--racine") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("[plan-cron] --racine attend un chemin\n");
        return 1;
      }
      racine = v;
    } else {
      process.stderr.write(`[plan-cron] argument inconnu : ${argv[i]}\n`);
      return 1;
    }
  }

  let resultat;
  try {
    resultat = await construireCrontab(racine);
  } catch (err) {
    const message = `[plan-cron] ${messageErreur(err)}`;
    process.stderr.write(`${message}\n`);
    await notifierNtfy("ia-runner : planification impossible", message);
    return 1;
  }

  const entete = [
    "# Crontab généré par docker/ia-runner/bin/plan-cron.mjs — NE PAS ÉDITER À LA MAIN.",
    `# Racine des tâches : ${racine}`,
    `# Généré le ${new Date().toISOString()}`,
    "# Seules les tâches 'enabled: true' ET 'lieu: serveur' sont planifiées ici.",
  ];
  if (resultat.ignorees.length > 0) {
    entete.push(`# Non planifiées : ${resultat.ignorees.join(", ")}`);
  }
  process.stdout.write(`${[...entete, ...resultat.lignes].join("\n")}\n`);

  if (resultat.erreurs.length > 0) {
    for (const e of resultat.erreurs) {
      process.stderr.write(`[plan-cron] ERREUR ${e}\n`);
    }
    await notifierNtfy(
      "ia-runner : tache(s) non planifiee(s)",
      `Tâches exclues du crontab :\n\n${resultat.erreurs.join("\n")}`,
    );
    return 1;
  }
  return 0;
}

// Exécuté seulement en ligne de commande : les tests importent ce module.
const estPrincipal =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (estPrincipal) {
  principal(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
