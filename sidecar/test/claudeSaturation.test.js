/*
 * T-059 — parser un refus de saturation d'abonnement, sans SDK ni process.
 *
 * La preuve directe du ticket (`app.jsonl`, 2026-08-15) : « échec du micro-tour
 * d'initialisation : Claude Code returned an error result: You've hit your
 * session limit · resets 7:10pm (Europe/Paris) », journalisé deux fois de
 * suite comme une panne générique pendant que l'information la plus fraîche
 * qui existe — quelle fenêtre, et quand elle se vide — traversait déjà
 * l'application sans être lue.
 *
 * Lancement isolé : node sidecar/test/claudeSaturation.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { parseRefusSaturation } = await import(moduleCompile("claudeSaturation.js"));

function testMessageNonReconnu() {
  assert(
    parseRefusSaturation("erreur réseau: fetch failed") === null,
    "un message qui n'est pas un refus de saturation ne doit rien produire",
  );
  console.log("OK: un message ordinaire n'est pas pris pour un refus de saturation");
}

function testSessionAvecFuseau() {
  // Cas réel du 2026-08-15 : heure + fuseau explicite, pas de date. Poser
  // `maintenant` à 17:00 Europe/Paris (15:00 UTC) : 19:10 heure de Paris est
  // encore À VENIR aujourd'hui.
  const maintenant = new Date("2026-08-15T15:00:00Z");
  const r = parseRefusSaturation("You've hit your session limit · resets 7:10pm (Europe/Paris)", maintenant);
  assert(r !== null && r.fenetre === "session", `fenêtre 'session' attendue, reçu ${JSON.stringify(r)}`);
  assert(typeof r.resetsAt === "string", "resetsAt doit être calculé quand l'heure est présente");
  const relu = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(r.resetsAt));
  assert(relu === "19:10", `resetsAt doit valoir 19:10 heure de Paris, reçu ${relu}`);
  assert(new Date(r.resetsAt).getTime() > maintenant.getTime(), "resetsAt doit être dans le futur");
  console.log("OK: 'resets 7:10pm (Europe/Paris)' → session, resetsAt = 19:10 Europe/Paris");
}

function testHeureDejaPasseeRouleSurDemain() {
  // À 20:00 Europe/Paris, « resets 7:10pm (Europe/Paris) » ne peut viser QUE demain.
  const maintenant = new Date("2026-08-15T18:00:00Z"); // 20:00 Europe/Paris (été, UTC+2)
  const r = parseRefusSaturation("You've hit your session limit · resets 7:10pm (Europe/Paris)", maintenant);
  assert(r !== null && r.resetsAt !== null, "resetsAt doit être calculé");
  const joursEcart = Math.round((new Date(r.resetsAt).getTime() - maintenant.getTime()) / (60 * 60 * 1000));
  assert(joursEcart > 0 && joursEcart < 24, `resetsAt doit tomber le lendemain, écart ${joursEcart} h`);
  console.log("OK: une heure déjà passée aujourd'hui roule sur demain");
}

function testHebdoAvecDate() {
  const maintenant = new Date("2026-09-01T10:00:00Z");
  const r = parseRefusSaturation("You've hit your weekly limit · resets Oct 9, 7:00pm", maintenant);
  assert(r !== null && r.fenetre === "hebdo", `fenêtre 'hebdo' attendue, reçu ${JSON.stringify(r)}`);
  assert(typeof r.resetsAt === "string", "resetsAt doit être calculé même sans fuseau explicite");
  assert(new Date(r.resetsAt).getMonth() === 9, "le mois attendu est octobre (index 9)"); // 0 = janvier
  console.log("OK: 'resets Oct 9, 7:00pm' → hebdo, resetsAt daté en octobre");
}

function testHeureRondeSansMinutes() {
  // T-130 — constat du 2026-09-18, capture à l'appui : le badge disait
  // « reprise à heure inconnue » alors que le fil portait « resets 6pm ».
  // Quand la réinitialisation tombe sur une heure PLEINE, le SDK omet les
  // minutes ; le motif de T-059 les exigeait.
  const maintenant = new Date("2026-09-18T12:00:00Z"); // 14:00 Europe/Paris
  const r = parseRefusSaturation("You've hit your session limit · resets 6pm (Europe/Paris)", maintenant);
  assert(r !== null && r.fenetre === "session", `fenêtre 'session' attendue, reçu ${JSON.stringify(r)}`);
  assert(typeof r.resetsAt === "string", "resetsAt doit être calculé sans minutes dans le message");
  const relu = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(r.resetsAt));
  assert(relu === "18:00", `resetsAt doit valoir 18:00 heure de Paris, reçu ${relu}`);
  console.log("OK: 'resets 6pm (Europe/Paris)' → session, resetsAt = 18:00 Europe/Paris");
}

function testHebdoAvecDateSansMinutes() {
  // Même omission sur le format daté : « resets Oct 9, 7pm ».
  const maintenant = new Date("2026-09-01T10:00:00Z");
  const r = parseRefusSaturation("You've hit your weekly limit · resets Oct 9, 7pm", maintenant);
  assert(r !== null && r.fenetre === "hebdo", `fenêtre 'hebdo' attendue, reçu ${JSON.stringify(r)}`);
  assert(typeof r.resetsAt === "string", "resetsAt doit être calculé sans minutes dans le message");
  const d = new Date(r.resetsAt);
  assert(d.getMonth() === 9 && d.getDate() === 9, "le 9 octobre est attendu");
  assert(d.getHours() === 19 && d.getMinutes() === 0, `19:00 locale attendue, reçu ${d.getHours()}:${d.getMinutes()}`);
  console.log("OK: 'resets Oct 9, 7pm' → hebdo, resetsAt au 9 octobre 19:00 locale");
}

function testAbsenceHeure() {
  // Aucun format connu : resetsAt reste null, à la charge de l'appelant
  // (30 min de silence par défaut — voir cadenceUsage.ts, armerSilence).
  const r = parseRefusSaturation("You've hit your session limit for today.");
  assert(r !== null && r.fenetre === "session", "la fenêtre doit rester reconnue");
  assert(r.resetsAt === null, `resetsAt doit être null sans heure exploitable, reçu ${r.resetsAt}`);
  console.log("OK: absence d'heure exploitable → resetsAt null, fenêtre reconnue quand même");
}

await lancer(
  "T-059 — parser un refus de saturation d'abonnement",
  testMessageNonReconnu,
  testSessionAvecFuseau,
  testHeureDejaPasseeRouleSurDemain,
  testHebdoAvecDate,
  testHeureRondeSansMinutes,
  testHebdoAvecDateSansMinutes,
  testAbsenceHeure,
);
