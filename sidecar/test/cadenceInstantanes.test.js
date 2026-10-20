/*
 * T-073 — cadence d'écriture de `claude-windows.jsonl`.
 *
 * Mesure d'origine, sur le fichier du poste : 22 324 instantanés, 4,3 Mo, dont
 * **72,7 % répètent l'utilisation du précédent**, écart médian 4,9 s.
 *
 * Le piège que ce fichier verrouille, et qu'une lecture de code n'aurait pas
 * révélé : `resetsAt` porte des MICROSECONDES qui bougent à chaque lecture
 * (`23:09:59.811629` puis `23:09:59.557394` pour la même fenêtre). Une
 * déduplication naïve sur l'objet brut n'aurait jamais rien dédoublonné — et
 * serait passée pour un correctif.
 *
 * Lancement isolé : node sidecar/test/cadenceInstantanes.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { signatureFenetres, doitEnregistrerInstantane, INSTANTANE_BATTEMENT_MS } = await import(
  moduleCompile("fenetresAbonnement.js")
);

const T0 = 1_700_000_000_000;

function fenetres(cinqH, sept, resetSuffixe = "811629+00:00") {
  return {
    five_hour: { utilization: cinqH, resetsAt: `2026-08-20T23:09:59.${resetSuffixe}` },
    seven_day: { utilization: sept, resetsAt: `2026-08-22T17:59:59.${resetSuffixe}` },
  };
}

await lancer(
  "T-073 — cadence des instantanés de fenêtres",

  async function microsecondes_ignorees() {
    // Le cas réel du 2026-08-20 : mêmes utilisations, `resetsAt` qui diffère
    // sous la seconde. C'est ce bruit qui rendait 72,7 % du fichier inutile.
    const a = signatureFenetres(fenetres(8, 77, "811629+00:00"));
    const b = signatureFenetres(fenetres(8, 77, "557394+00:00"));
    assert(a === b, `signatures attendues égales :\n  ${a}\n  ${b}`);
    console.log("OK: les microsecondes de resetsAt ne comptent pas");
  },

  async function changement_dutilisation_ecrit_tout_de_suite() {
    const avant = { signature: signatureFenetres(fenetres(8, 77)), ts: T0 };
    const apres = signatureFenetres(fenetres(9, 77));
    // 1 seconde plus tard : l'utilisation a bougé, on écrit sans attendre.
    assert(doitEnregistrerInstantane(avant, apres, T0 + 1000), "un changement doit être écrit tout de suite");
    console.log("OK: un changement d'utilisation est écrit immédiatement");
  },

  async function reinitialisation_de_fenetre_est_un_changement() {
    // Même utilisation, mais la fenêtre s'est réinitialisée : `resetsAt` saute
    // de cinq heures. C'est un événement, pas du bruit.
    const avant = { signature: signatureFenetres(fenetres(8, 77)), ts: T0 };
    const apres = signatureFenetres({
      five_hour: { utilization: 8, resetsAt: "2026-08-21T04:09:59.000000+00:00" },
      seven_day: { utilization: 77, resetsAt: "2026-08-22T17:59:59.811629+00:00" },
    });
    assert(doitEnregistrerInstantane(avant, apres, T0 + 1000), "une réinitialisation de fenêtre doit être écrite");
    console.log("OK: une fenêtre qui se réinitialise est un changement");
  },

  async function identique_et_recent_est_ecarte() {
    const sig = signatureFenetres(fenetres(8, 77));
    const avant = { signature: sig, ts: T0 };
    assert(!doitEnregistrerInstantane(avant, sig, T0 + 5000), "5 s plus tard, rien de neuf : à écarter");
    assert(
      !doitEnregistrerInstantane(avant, sig, T0 + INSTANTANE_BATTEMENT_MS - 1),
      "juste avant le battement : toujours à écarter",
    );
    console.log("OK: un instantané identique et récent n'est pas écrit");
  },

  async function identique_mais_vieux_garde_la_base_de_temps() {
    // Un long plateau doit rester distinguable d'une absence de relevé : sans
    // ce battement, on ne saurait pas si « rien n'a bougé » ou « personne n'a
    // regardé » — la confusion même que T-059 reproche à la jauge de session.
    const sig = signatureFenetres(fenetres(8, 77));
    const avant = { signature: sig, ts: T0 };
    assert(
      doitEnregistrerInstantane(avant, sig, T0 + INSTANTANE_BATTEMENT_MS),
      "au battement, on réécrit même à l'identique",
    );
    console.log("OK: le battement garde une base de temps sur les plateaux");
  },

  async function premier_instantane_toujours_ecrit() {
    assert(doitEnregistrerInstantane(null, signatureFenetres(fenetres(1, 1)), T0), "le premier relevé s'écrit");
    console.log("OK: le premier instantané est toujours écrit");
  },

  async function fenetre_mal_formee_ne_casse_rien() {
    // L'API est expérimentale : une fenêtre sans `utilization` ne doit ni
    // faire échouer la signature, ni se confondre avec une fenêtre valide.
    const sigCassee = signatureFenetres({ five_hour: { resetsAt: "2026-08-20T23:09:59Z" }, autre: 42 });
    const sigValide = signatureFenetres(fenetres(8, 77));
    assert(typeof sigCassee === "string" && sigCassee.length > 0, "signature produite malgré la forme inattendue");
    assert(sigCassee !== sigValide, "une forme inattendue ne se confond pas avec un relevé valide");
    console.log("OK: une fenêtre mal formée ne casse pas la signature");
  },
);
