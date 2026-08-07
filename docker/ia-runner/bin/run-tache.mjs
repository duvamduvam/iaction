#!/usr/bin/env node
/**
 * ia-runner — exécution d'UNE tâche planifiée (tranche D1, docs/etude-remote.md).
 *
 * Enchaînement : verrou → synchro descendante → lecture du manifeste →
 * résolution du projet → exécution du runner headless → état → synchro
 * montante → notification si échec.
 *
 * Trois points durs, tous dictés par l'étude :
 *
 * 1. **Résolution du projet.** Le manifeste porte un `cwd` ABSOLU du poste
 *    (`/home/<utilisateur>/…`) qui n'existe pas ici. On résout par NOM DE DOSSIER sous
 *    `IA_RUNNER_PROJETS_DIR` (liste blanche synchronisée), avec un champ
 *    facultatif `projet:` prioritaire. Introuvable = ÉCHEC explicite : un repli
 *    silencieux ferait tourner l'orchestration dans le mauvais répertoire, donc
 *    sur les mauvaises connaissances, sans que personne ne le voie.
 *
 * 2. **Zones d'écriture disjointes** (règle d'or, § 3 de l'étude). La synchro
 *    montante ne remonte QUE les zones serveur : `rapports/` des tâches,
 *    journal, `IA_RUNNER_ETAT_DIR`, et `.iaction/connaissances-index/` des
 *    projets. JAMAIS les sources d'un projet — c'est sync-up.sh qui porte les
 *    filtres, ce script ne fait que l'appeler.
 *
 * 3. **Exécution séquentielle** (§ 4). Verrou par dossier (mkdir est atomique
 *    sur POSIX, et ça évite de dépendre de `flock`, absent de bien des images).
 *    Le verrou vit dans un dossier VOLATILE (/tmp par défaut) : au redémarrage
 *    du conteneur il disparaît de lui-même, ce qu'on veut, puisqu'un éventuel
 *    détenteur est mort avec lui.
 *
 * La ligne de commande passée au runner headless reproduit EXACTEMENT celle des
 * unités systemd du poste (`sidecar/src/tachesTimers.ts`, `buildServiceUnit`) :
 * `node <runner> <cwd> <orchestration> [--input k=v ...] [--save-output <tacheDir>/<report>]`,
 * sorties standard ET erreur ajoutées à `<tacheDir>/rapports/journal.log`.
 *
 * Usage :
 *   node run-tache.mjs <nom-de-tache>
 *   node run-tache.mjs --sync      (synchro descendante+montante seule, sans attendre le verrou)
 */

import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lireManifeste,
  messageErreur,
  notifierNtfy,
  racineEtat,
  racineProjets,
  racineTaches,
} from "./plan-cron.mjs";

const DOSSIER_BIN = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DOWN = path.join(DOSSIER_BIN, "sync-down.sh");
const SYNC_UP = path.join(DOSSIER_BIN, "sync-up.sh");

/**
 * Runner headless du dépôt, réutilisé TEL QUEL (§ 4 de l'étude : « réutilisation
 * directe de scripts/orch-run-headless.mjs, déjà éprouvé par les timers T2 »).
 * `bin/` est à `docker/ia-runner/bin/`, la racine du dépôt est donc trois
 * niveaux au-dessus (= `/app` dans le conteneur).
 */
const RACINE_DEPOT = path.resolve(DOSSIER_BIN, "..", "..", "..");
const RUNNER_HEADLESS = path.join(RACINE_DEPOT, "scripts", "orch-run-headless.mjs");

const NOM_RE = /^[a-z0-9-]{1,64}$/;
const ATTENTE_VERROU_DEFAUT_SEC = 1800;
const INTERVALLE_SONDAGE_MS = 5000;
/** Délai laissé au runner entre le SIGTERM (qui déclenche son `orch.abort`) et le SIGKILL. */
const GRACE_SIGKILL_MS = 60_000;

// ---------------------------------------------------------------------------
// Journalisation — toujours en double : stdout (capté par supercronic, donc
// `docker logs`) ET journal de la tâche (synchronisé, donc lisible dans l'app).
// Un run nocturne n'a personne devant l'écran : la trace doit exister aux deux
// endroits (docs/etude-logs.md § 1.2).
// ---------------------------------------------------------------------------

let cheminJournal = null;

function horodatage() {
  return new Date().toISOString();
}

function journaliser(message, niveau = "info") {
  const ligne = `[run-tache] ${horodatage()} ${niveau === "erreur" ? "ERREUR " : ""}${message}\n`;
  if (niveau === "erreur") {
    process.stderr.write(ligne);
  } else {
    process.stdout.write(ligne);
  }
  if (cheminJournal) {
    // Écriture synchrone volontaire : on préfère un journal complet à un
    // journal rapide, et ces lignes sont rares (quelques-unes par run).
    try {
      mkdirSync(path.dirname(cheminJournal), { recursive: true });
      appendFileSync(cheminJournal, ligne);
    } catch {
      // Journal inaccessible : la trace stdout reste, et on ne masque pas
      // l'erreur d'origine derrière une erreur d'écriture de journal.
    }
  }
}

// ---------------------------------------------------------------------------
// Verrou d'exécution séquentielle
// ---------------------------------------------------------------------------

function cheminVerrou() {
  const v = process.env.IA_RUNNER_VERROU;
  return typeof v === "string" && v.length > 0 ? v : "/tmp/ia-runner/verrou";
}

/**
 * Prise du verrou : `mkdir` échoue avec EEXIST si un autre run le détient —
 * c'est l'opération atomique la plus portable qui soit.
 *
 * `attenteMaxSec = 0` (mode `--sync`) : on n'attend pas, une synchro périodique
 * qui tombe pendant une tâche se contente du tour suivant.
 */
async function prendreVerrou(proprietaire, attenteMaxSec) {
  const verrou = cheminVerrou();
  const debutAttente = Date.now();
  let attenteSignalee = false;

  try {
    await fsp.mkdir(path.dirname(verrou), { recursive: true });
  } catch (err) {
    return { ok: false, message: `dossier du verrou inutilisable (${verrou}) : ${messageErreur(err)}` };
  }

  for (;;) {
    try {
      // `recursive: false` : c'est TOUT l'intérêt du procédé — la création
      // échoue si le dossier existe déjà, atomiquement.
      await fsp.mkdir(verrou, { recursive: false });
      await fsp
        .writeFile(
          path.join(verrou, "detenteur.json"),
          JSON.stringify({ proprietaire, pid: process.pid, depuis: horodatage() }, null, 2),
          "utf8",
        )
        .catch(() => {});
      return { ok: true, liberer: () => fsp.rm(verrou, { recursive: true, force: true }) };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        return { ok: false, message: `verrou inutilisable (${verrou}) : ${messageErreur(err)}` };
      }
    }

    const ecouleSec = (Date.now() - debutAttente) / 1000;
    if (ecouleSec >= attenteMaxSec) {
      let detenteur = "(détenteur inconnu)";
      try {
        detenteur = (await fsp.readFile(path.join(verrou, "detenteur.json"), "utf8")).replace(/\s+/g, " ").trim();
      } catch {
        // Verrou sans fiche : on le signale tel quel plutôt que de le forcer.
      }
      return {
        ok: false,
        message:
          attenteMaxSec === 0
            ? `verrou occupé, opération sautée — ${detenteur}`
            : `verrou toujours occupé après ${Math.round(ecouleSec)} s d'attente — ${detenteur}`,
      };
    }
    if (!attenteSignalee) {
      attenteSignalee = true;
      journaliser(
        `une autre tâche occupe le runner : mise en attente (jusqu'à ${attenteMaxSec} s) — exécution séquentielle imposée`,
      );
    }
    await new Promise((r) => setTimeout(r, INTERVALLE_SONDAGE_MS));
  }
}

// ---------------------------------------------------------------------------
// Sous-processus
// ---------------------------------------------------------------------------

/**
 * Lance un sous-processus. `journal` (facultatif) = chemin de fichier où
 * AJOUTER stdout+stderr, en plus du relais vers nos propres flux.
 */
function executer(commande, args, options = {}) {
  return new Promise((resolve) => {
    let enfant;
    try {
      enfant = spawn(commande, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
      });
    } catch (err) {
      resolve({ code: null, signal: null, echec: true, message: messageErreur(err), tueParTimeout: false });
      return;
    }

    let fluxJournal = null;
    if (options.journal) {
      try {
        mkdirSync(path.dirname(options.journal), { recursive: true });
        fluxJournal = createWriteStream(options.journal, { flags: "a" });
      } catch (err) {
        journaliser(`journal ${options.journal} non ouvrable : ${messageErreur(err)}`, "erreur");
      }
    }

    const relayer = (flux, sortie) => {
      flux.on("data", (bloc) => {
        sortie.write(bloc);
        fluxJournal?.write(bloc);
      });
    };
    relayer(enfant.stdout, process.stdout);
    relayer(enfant.stderr, process.stderr);

    let tueParTimeout = false;
    let minuteurGrace = null;
    let minuteur = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      minuteur = setTimeout(() => {
        tueParTimeout = true;
        journaliser(
          `délai maximal atteint (${Math.round(options.timeoutMs / 60000)} min) : SIGTERM au runner`,
          "erreur",
        );
        enfant.kill("SIGTERM");
        // Le runner headless intercepte SIGTERM pour annuler proprement le run
        // (orch.abort) ; on ne l'achève qu'après cette fenêtre de grâce.
        minuteurGrace = setTimeout(() => {
          journaliser("le runner n'a pas rendu la main après SIGTERM : SIGKILL", "erreur");
          enfant.kill("SIGKILL");
        }, GRACE_SIGKILL_MS);
      }, options.timeoutMs);
    }

    enfant.on("error", (err) => {
      if (minuteur) clearTimeout(minuteur);
      if (minuteurGrace) clearTimeout(minuteurGrace);
      fluxJournal?.end();
      resolve({ code: null, signal: null, echec: true, message: messageErreur(err), tueParTimeout });
    });
    enfant.on("close", (code, signal) => {
      if (minuteur) clearTimeout(minuteur);
      if (minuteurGrace) clearTimeout(minuteurGrace);
      fluxJournal?.end();
      resolve({
        code,
        signal,
        echec: code !== 0,
        message: code === 0 ? "" : `code de sortie ${code}${signal ? ` (signal ${signal})` : ""}`,
        tueParTimeout,
      });
    });
  });
}

async function synchroniser(script, etiquette) {
  const resultat = await executer(script, [], { journal: cheminJournal });
  if (resultat.echec) {
    return { ok: false, message: `${etiquette} en échec : ${resultat.message}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Résolution du projet
// ---------------------------------------------------------------------------

/**
 * Résout le répertoire de travail passé au runner.
 *
 * Ordre : `projet` (nom explicite) > nom de dossier de `cwd` > dossier de la
 * tâche (comportement historique de `buildServiceUnit` quand `cwd` est absent :
 * orchestrations globales seulement).
 *
 * `verifierDossier` est injecté pour que les tests couvrent la résolution sans
 * fabriquer d'arborescence.
 */
export async function resoudreProjet(tache, options = {}) {
  const racine = options.racineProjets ?? racineProjets();
  const dossierTache = options.dossierTache;
  const existe =
    options.verifierDossier ??
    (async (chemin) => {
      try {
        return (await fsp.stat(chemin)).isDirectory();
      } catch {
        return false;
      }
    });

  const nomDemande = tache.projet ?? (tache.cwd ? path.basename(tache.cwd.replace(/[\\/]+$/, "")) : null);

  if (nomDemande === null) {
    if (!dossierTache) {
      return { ok: false, message: "aucun projet demandé et aucun dossier de tâche fourni" };
    }
    return { ok: true, chemin: dossierTache, origine: "dossier de la tâche (aucun 'projet' ni 'cwd')" };
  }
  if (nomDemande.length === 0 || nomDemande === "." || nomDemande === "..") {
    return { ok: false, message: `nom de projet inexploitable, déduit de cwd='${tache.cwd}'` };
  }

  const candidat = path.join(racine, nomDemande);
  if (await existe(candidat)) {
    return {
      ok: true,
      chemin: candidat,
      origine: tache.projet ? `champ 'projet: ${nomDemande}'` : `nom de dossier de cwd='${tache.cwd}'`,
    };
  }

  // Aucun repli : mieux vaut une tâche qui ne tourne pas et le dit qu'une tâche
  // qui tourne sur le mauvais projet (voir en-tête, point 1).
  return {
    ok: false,
    message:
      `projet '${nomDemande}' introuvable sous ${racine} ` +
      `(déduit de ${tache.projet ? "'projet'" : `cwd='${tache.cwd}'`}) — ` +
      "le projet est-il bien dans la liste blanche synchronisée ?",
  };
}

// ---------------------------------------------------------------------------
// État d'exécution (zone serveur, relue par l'app au rallumage — § 6/§ 7)
// ---------------------------------------------------------------------------

/** Date LOCALE `YYYY-MM-DD` — même convention que le runner headless. */
function dateLocaleISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${j}`;
}

async function ecrireEtat(nom, etat) {
  const racine = racineEtat();
  const dossierDernier = path.join(racine, "dernier");
  const dossierExecutions = path.join(racine, "executions", nom);
  const estampille = etat.debut.replace(/[:.]/g, "-");
  try {
    await fsp.mkdir(dossierDernier, { recursive: true });
    await fsp.mkdir(dossierExecutions, { recursive: true });
    const contenu = `${JSON.stringify(etat, null, 2)}\n`;
    await fsp.writeFile(path.join(dossierExecutions, `${estampille}.json`), contenu, "utf8");
    await fsp.writeFile(path.join(dossierDernier, `${nom}.json`), contenu, "utf8");
  } catch (err) {
    // L'état est de l'observabilité : son échec ne doit pas masquer le résultat
    // de la tâche, mais il ne doit pas non plus passer inaperçu.
    journaliser(`écriture de l'état impossible sous ${racine} : ${messageErreur(err)}`, "erreur");
  }
}

// ---------------------------------------------------------------------------
// Mode `--sync` : synchro périodique appelée par entrypoint.sh
// ---------------------------------------------------------------------------

async function modeSync() {
  const verrou = await prendreVerrou("synchro périodique", 0);
  if (!verrou.ok) {
    journaliser(`synchro périodique reportée — ${verrou.message}`);
    return 0;
  }
  try {
    for (const [script, etiquette] of [
      [SYNC_DOWN, "synchro descendante"],
      [SYNC_UP, "synchro montante"],
    ]) {
      const r = await synchroniser(script, etiquette);
      if (!r.ok) {
        journaliser(r.message, "erreur");
        await notifierNtfy("ia-runner : synchro en echec", `${r.message}\n\nLe serveur risque de travailler sur des données périmées.`);
        return 1;
      }
    }
    return 0;
  } finally {
    await verrou.liberer();
  }
}

// ---------------------------------------------------------------------------
// Mode nominal : exécution d'une tâche
// ---------------------------------------------------------------------------

async function executerTache(nom) {
  const debut = horodatage();
  const debutMs = Date.now();
  const dossierTache = path.join(racineTaches(), nom);
  cheminJournal = path.join(dossierTache, "rapports", "journal.log");

  const etatBase = { tache: nom, debut, fin: null, dureeMs: null, code: null, statut: "echec", rapport: null, journal: cheminJournal, projet: null, message: "" };

  const terminer = async (etat, code) => {
    const complet = { ...etatBase, ...etat, fin: horodatage(), dureeMs: Date.now() - debutMs };
    await ecrireEtat(nom, complet);
    // La synchro montante est faite MÊME en échec : c'est justement dans ce cas
    // que le journal et l'état doivent remonter jusqu'à l'app.
    const montee = await synchroniser(SYNC_UP, "synchro montante");
    if (!montee.ok) {
      journaliser(montee.message, "erreur");
      await notifierNtfy(
        "ia-runner : synchro montante en echec",
        `Tâche « ${nom} » : ${montee.message}\n\nLe rapport et le journal ne sont PAS remontés vers l'app.`,
      );
      return code === 0 ? 1 : code;
    }
    return code;
  };

  journaliser(`=== tâche « ${nom} » — début ${debut} ===`);

  const verrou = await prendreVerrou(
    `tâche ${nom}`,
    Number(process.env.IA_RUNNER_ATTENTE_VERROU_SEC ?? ATTENTE_VERROU_DEFAUT_SEC),
  );
  if (!verrou.ok) {
    const message = `exécution reportée : ${verrou.message}`;
    journaliser(message, "erreur");
    await notifierNtfy("ia-runner : tache reportee", `Tâche « ${nom} » non exécutée.\n${verrou.message}`);
    // Pas de synchro montante ici, volontairement : le verrou appartient à une
    // autre tâche, et une synchro pendant son run est exactement ce que le
    // verrou empêche. Cet état partira avec la boucle périodique d'entrypoint.sh.
    await ecrireEtat(nom, { ...etatBase, statut: "reportee", fin: horodatage(), dureeMs: Date.now() - debutMs, message });
    return 1;
  }

  try {
    // 1. Synchro descendante AVANT toute lecture : le manifeste et le projet
    //    doivent être ceux du poste, pas ceux du dernier tour.
    const descente = await synchroniser(SYNC_DOWN, "synchro descendante");
    if (!descente.ok) {
      journaliser(descente.message, "erreur");
      await notifierNtfy(
        "ia-runner : synchro descendante en echec",
        `Tâche « ${nom} » non exécutée : ${descente.message}\n\nRefus de travailler sur des données périmées.`,
      );
      return await terminer({ statut: "echec", message: descente.message }, 1);
    }

    // 2. Manifeste (relu APRÈS la synchro).
    const entree = await lireManifeste(racineTaches(), nom);
    if (entree.erreur) {
      journaliser(entree.erreur, "erreur");
      await notifierNtfy("ia-runner : manifeste illisible", `Tâche « ${nom} » : ${entree.erreur}`);
      return await terminer({ statut: "echec", message: entree.erreur }, 1);
    }
    const tache = entree.tache;

    // Le crontab a pu être généré avant une désactivation : ce n'est pas un
    // échec, mais ça se dit (le crontab sera régénéré au prochain tour de
    // synchro, voir entrypoint.sh).
    if (!tache.enabled || tache.lieu !== "serveur") {
      const message = `tâche non exécutée : enabled=${tache.enabled}, lieu=${tache.lieu} (le crontab sera régénéré)`;
      journaliser(message);
      return await terminer({ statut: "ignoree", code: 0, message }, 0);
    }

    // 3. Projet.
    const projet = await resoudreProjet(tache, { dossierTache });
    if (!projet.ok) {
      journaliser(projet.message, "erreur");
      await notifierNtfy("ia-runner : projet introuvable", `Tâche « ${nom} » : ${projet.message}`);
      return await terminer({ statut: "echec", message: projet.message }, 1);
    }
    journaliser(`projet résolu : ${projet.chemin} (${projet.origine})`);

    // 4. Ligne de commande — identique à celle des unités systemd du poste
    //    (sidecar/src/tachesTimers.ts § buildServiceUnit).
    const args = [RUNNER_HEADLESS, projet.chemin, tache.orchestration];
    for (const [clef, valeur] of Object.entries(tache.inputs)) {
      args.push("--input", `${clef}=${valeur}`);
    }
    let rapport = null;
    if (tache.report) {
      const cible = path.join(dossierTache, tache.report);
      args.push("--save-output", cible);
      // Le gabarit `{{today}}` est résolu par le runner lui-même ; on le résout
      // ici AUSSI, uniquement pour que l'état publie le vrai chemin du rapport.
      rapport = cible.split("{{today}}").join(dateLocaleISO(new Date()));
    }

    const timeoutMs = Math.round(tache.timeoutMinutes * 60_000);
    journaliser(
      `lancement : ${tache.orchestration} (timeout ${tache.timeoutMinutes} min)` +
        (tache.report ? ` — rapport ${rapport}` : ""),
    );

    const resultat = await executer(process.execPath, args, { journal: cheminJournal, timeoutMs });

    // 5. Statut. Le runner headless code 0 = success, 2 = partial, 1 = échec.
    let statut = "succes";
    if (resultat.tueParTimeout) {
      statut = "timeout";
    } else if (resultat.code === 2) {
      statut = "partiel";
    } else if (resultat.code !== 0) {
      statut = "echec";
    }
    const message = resultat.tueParTimeout
      ? `interrompu au bout de ${tache.timeoutMinutes} min`
      : resultat.message || "terminé";
    journaliser(`=== tâche « ${nom} » — fin : ${statut} (${message}) ===`, statut === "succes" ? "info" : "erreur");

    if (statut !== "succes") {
      await notifierNtfy(
        `ia-runner : tache ${nom} en echec`,
        `Tâche « ${nom} » : ${statut} (${message})\nProjet : ${projet.chemin}\nJournal : ${cheminJournal}`,
      );
    }

    return await terminer(
      { statut, code: resultat.code, rapport, projet: projet.chemin, message },
      resultat.code ?? 1,
    );
  } finally {
    await verrou.liberer();
  }
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

async function principal(argv) {
  if (argv.length === 1 && argv[0] === "--sync") {
    return await modeSync();
  }
  // Relais de notification pour les scripts shell : l'image finale n'embarque
  // pas `curl` (voir docker/ia-runner/Dockerfile), alors que `node` y est par
  // construction. Passer par ici évite aussi de réécrire en shell la gestion
  // des accents dans l'en-tête `Title`.
  if (argv[0] === "--notifier") {
    const titre = argv[1] ?? "ia-runner";
    const message = argv[2] ?? "";
    return (await notifierNtfy(titre, message)) ? 0 : 1;
  }
  const nom = argv[0];
  if (argv.length !== 1 || typeof nom !== "string" || !NOM_RE.test(nom)) {
    process.stderr.write(
      "Usage : node run-tache.mjs <nom-de-tache>   (nom en [a-z0-9-]{1,64})\n" +
        "        node run-tache.mjs --sync         (synchro descendante + montante seule)\n",
    );
    return 1;
  }
  try {
    return await executerTache(nom);
  } catch (err) {
    const message = `erreur inattendue sur la tâche « ${nom} » : ${messageErreur(err)}`;
    journaliser(message, "erreur");
    await notifierNtfy("ia-runner : erreur inattendue", message);
    return 1;
  }
}

// Exécuté seulement en ligne de commande : les tests importent ce module.
const estPrincipal =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (estPrincipal) {
  const code = await principal(process.argv.slice(2));
  process.exitCode = code;
}
