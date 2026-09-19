/*
 * T-082 — « panne » et « interruption » ne sont pas le même événement.
 *
 * Le défaut mesuré le 2026-08-19 sur la semaine S34 : 11 tours affichés en
 * erreur sur 82 (13,3 %), tous sous la cause `error_during_execution`, à côté
 * d'un compteur d'abandons à 0,0 %. Recoupement avec les transcripts du SDK :
 * les 11 étaient des interruptions de l'utilisateur — 8 arrêts, 3 refus de
 * permission d'outil. Aucune panne. Le KPI le plus alarmant de la page
 * mesurait un usage parfaitement normal.
 *
 * Ce fichier verrouille les deux moitiés du remède, toutes deux PURES :
 *   1. le classement d'une fin de tour (claudeFinDeTour.ts) ;
 *   2. sa lecture par l'agrégat de sobriété (usageSobriete.ts), qui doit
 *      ventiler les interruptions SANS jamais les verser dans les pannes.
 *
 * Lancement isolé : node sidecar/test/finDeTour.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { classerIssueDeTour, libelleAbandonUtilisateur, subtypePourInterface } = await import(
  moduleCompile("claudeFinDeTour.js")
);
const { newSobrieteAgg, applySobrieteEvent, finalizeSobriete } = await import(
  moduleCompile("usageSobriete.js")
);

function testSucces() {
  const ok = classerIssueDeTour("success", null);
  assert(ok.status === "done", `succès ⇒ done, reçu ${ok.status}`);
  assert(ok.errorMessage === null, "succès ⇒ aucune raison");
  assert(ok.trace === null, "succès ⇒ rien à journaliser");

  // Un succès reste un succès même si une interruption a été notée en route :
  // le tour a fini son travail, c'est ce que dit le subtype.
  const malgre = classerIssueDeTour("success", "refus");
  assert(malgre.status === "done", "succès malgré un refus ⇒ done");

  console.log("OK: classerIssueDeTour — le succès prime sur tout indicateur");
}

function testPanne() {
  const ko = classerIssueDeTour("error_during_execution", null);
  assert(ko.status === "error", `non-succès sans interruption ⇒ error, reçu ${ko.status}`);
  // L4 — le subtype EST la cause, et rien d'autre n'entre dans le journal.
  assert(ko.errorMessage === "résultat Claude: error_during_execution",
    `cause attendue du subtype, reçu ${ko.errorMessage}`);
  assert(ko.trace?.niveau === "error", "une panne laisse une ligne de niveau error");

  const maxTurns = classerIssueDeTour("error_max_turns", null);
  assert(maxTurns.status === "error" && maxTurns.errorMessage.includes("error_max_turns"),
    "error_max_turns reste une panne, avec sa cause");

  console.log("OK: classerIssueDeTour — sans interruption, un non-succès reste une panne criée");
}

function testInterruptions() {
  const arret = classerIssueDeTour("error_during_execution", "abandon");
  assert(arret.status === "aborted", `arrêt demandé ⇒ aborted, reçu ${arret.status}`);
  assert(arret.errorMessage === "interrompu: arrêt demandé",
    `libellé d'arrêt attendu, reçu ${arret.errorMessage}`);
  // Tracé quand même — un tour qui s'arrête laisse une trace — mais en `info` :
  // noyer le journal d'`error` rendrait la vraie panne introuvable.
  assert(arret.trace?.niveau === "info", "une interruption se journalise en info, pas en error");

  const refus = classerIssueDeTour("error_during_execution", "refus");
  assert(refus.status === "aborted", "refus de permission ⇒ aborted");
  assert(refus.errorMessage === "interrompu: permission d'outil refusée",
    `libellé de refus attendu, reçu ${refus.errorMessage}`);
  assert(refus.errorMessage !== arret.errorMessage,
    "les deux interruptions ne se corrigent pas pareil : elles ne se confondent pas");

  console.log("OK: classerIssueDeTour — arrêt et refus sortent en aborted, distincts, tracés en info");
}

function testAgregatSepareLesDeux() {
  const agg = newSobrieteAgg();
  const d = new Date("2026-08-17T10:00:00Z");
  // Le lot réellement observé sur S34, en miniature : 8 arrêts, 3 refus,
  // 1 vraie panne, et un tour réussi pour le dénominateur.
  for (let i = 0; i < 8; i++) {
    applySobrieteEvent(agg, { status: "aborted", errorMessage: "interrompu: arrêt demandé" }, d);
  }
  for (let i = 0; i < 3; i++) {
    applySobrieteEvent(agg, { status: "aborted", errorMessage: "interrompu: permission d'outil refusée" }, d);
  }
  applySobrieteEvent(agg, { status: "error", errorMessage: "résultat Claude: error_during_execution" }, d);
  applySobrieteEvent(agg, { status: "done", errorMessage: null }, d);

  const out = finalizeSobriete(agg);
  assert(out.toursErreur === 1, `1 seule panne attendue, reçu ${out.toursErreur}`);
  assert(out.toursAbandon === 11, `11 interruptions attendues, reçu ${out.toursAbandon}`);
  assert(out.parCause.length === 1 && out.parCause[0].tours === 1,
    "la ventilation des pannes ne contient QUE la panne");
  assert(!out.parCause.some((c) => c.cause.startsWith("interrompu:")),
    "aucune interruption ne doit apparaître dans la ventilation des pannes");

  const abandons = Object.fromEntries(out.parCauseAbandon.map((c) => [c.cause, c.tours]));
  assert(abandons["interrompu: arrêt demandé"] === 8, "8 arrêts ventilés");
  assert(abandons["interrompu: permission d'outil refusée"] === 3, "3 refus ventilés");
  // Tri décroissant : l'encart lit la liste dans l'ordre où il la dessine.
  assert(out.parCauseAbandon[0].tours >= out.parCauseAbandon[1].tours,
    "ventilation des interruptions triée par nombre décroissant");

  console.log("OK: sobriété — 11 interruptions et 1 panne, comptées et ventilées séparément");
}

function testHistoriqueAnterieur() {
  // Les abandons écrits AVANT T-082 n'ont pas de cause. Ils doivent tomber
  // dans la classe explicite de T-076, jamais disparaître ni se déguiser.
  const agg = newSobrieteAgg();
  applySobrieteEvent(agg, { status: "aborted", errorMessage: null }, new Date("2026-08-10T10:00:00Z"));
  const out = finalizeSobriete(agg);
  assert(out.toursAbandon === 1, "l'abandon ancien est compté");
  assert(out.parCauseAbandon[0].cause === "(aucune cause enregistrée, antérieur au 2026-08-01)",
    `classe explicite datée attendue, reçu ${out.parCauseAbandon[0].cause}`);
  console.log("OK: sobriété — un abandon d'avant T-082 se voit, sans cause inventée");
}

function testLibelleAbandonUtilisateur() {
  // T-076 — le moteur neutre (neutralAgent.ts) et chat.send (engine.ts)
  // réutilisent CE libellé plutôt que de le recopier : un seul endroit à
  // corriger, une seule classe dans l'agrégat de sobriété.
  assert(
    libelleAbandonUtilisateur("aborted") === "interrompu: arrêt demandé",
    `libellé attendu pour 'aborted', reçu ${libelleAbandonUtilisateur("aborted")}`,
  );
  assert(libelleAbandonUtilisateur("done") === null, "aucun libellé sur un succès");
  assert(libelleAbandonUtilisateur("error") === null, "aucun libellé sur une panne (sa cause vient d'ailleurs)");
  console.log("OK: libelleAbandonUtilisateur — même libellé que LIBELLE_INTERRUPTION.abandon, rien sur le reste");
}

function testSubtypePourInterface() {
  // T-102 — l'UI recevait le subtype BRUT du SDK même quand l'interruption
  // était déjà connue : `error_during_execution` d'un arrêt demandé y
  // affichait une panne. La classe doit primer.
  assert(
    subtypePourInterface("error_during_execution", "abandon") === "aborted",
    "un arrêt demandé masque le subtype brut derrière 'aborted'",
  );
  // Volontairement PAS pour un refus (voir subtypePourInterface) : le subtype
  // brut reste transmis tel quel, comme avant T-102.
  assert(
    subtypePourInterface("error_during_execution", "refus") === "error_during_execution",
    "un refus de permission NE masque PAS le subtype brut",
  );
  // Sans interruption connue, le subtype brut passe tel quel — succès comme
  // vraie panne : rien n'est perdu pour ce que journal/usage doivent lire.
  assert(subtypePourInterface("success", null) === "success", "un succès garde son subtype");
  assert(
    subtypePourInterface("error_during_execution", null) === "error_during_execution",
    "une vraie panne garde son subtype (rien à maquiller)",
  );

  console.log("OK: subtypePourInterface — seul un abandon EXPLICITE masque le subtype ambigu");
}

await lancer(
  "T-082 — fin de tour : panne ou interruption",
  testSucces,
  testPanne,
  testInterruptions,
  testAgregatSepareLesDeux,
  testHistoriqueAnterieur,
  testLibelleAbandonUtilisateur,
  testSubtypePourInterface,
);
