/*
 * Politique du veilleur (veilleurPolitique.ts) — qui est écouté, dédoublonnage,
 * profondeur et plafonds. Fonctions pures, aucune ressource.
 *
 * Lancement isolé : node sidecar/test/veilleurPolitique.test.js
 */

import { assert, fail, moduleCompile } from "./harness.mjs";

const { expediteurEcoute, dejaTraite, profondeurSuivante, filDoitSArreter, motifRefus } = await import(
  moduleCompile("veilleurPolitique.js")
);

let ok = 0;
const cas = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const plafonds = { profondeur: 6, coutParMessage: 5, toursParJour: 100 };
const base = {
  de: "maison",
  ecoutes: ["maison"],
  id: "m1",
  profondeur: 0,
  coutEstime: 0.5,
  toursAujourdhui: 0,
  idsTraites: [],
  plafonds,
};

cas("un message de la maison, neuf, sous les plafonds : exécuté", () => {
  assert(motifRefus(base) === null, "pas de refus");
});

cas("émetteur non écouté : refus silencieux", () => {
  const r = motifRefus({ ...base, de: "inconnu" });
  assert(r !== null && r.silencieux === true, "refus silencieux");
  assert(r.motif.includes("inconnu"), "motif nomme l'émetteur");
});

cas("id déjà traité : refus silencieux", () => {
  const r = motifRefus({ ...base, idsTraites: ["m1"] });
  assert(r !== null && r.silencieux === true, "refus silencieux");
});

cas("profondeur au plafond : refus répondu (non silencieux)", () => {
  const r = motifRefus({ ...base, profondeur: 6 });
  assert(r !== null && r.silencieux === false, "refus répondu");
  assert(r.motif.includes("profondeur"), "motif profondeur");
});

cas("quota de tours atteint : refus répondu", () => {
  const r = motifRefus({ ...base, toursAujourdhui: 100 });
  assert(r !== null && r.silencieux === false, "refus répondu");
  assert(r.motif.includes("quota"), "motif quota");
});

cas("coût au-dessus du plafond : refus répondu", () => {
  const r = motifRefus({ ...base, coutEstime: 9 });
  assert(r !== null && r.silencieux === false, "refus répondu");
  assert(r.motif.includes("coût"), "motif coût");
});

cas("coût inconnu (null) ne refuse pas sur le coût", () => {
  assert(motifRefus({ ...base, coutEstime: null }) === null, "pas de refus");
});

cas("plafonds à 0 désactivent coût et tours", () => {
  const sans = { profondeur: 6, coutParMessage: 0, toursParJour: 0 };
  assert(motifRefus({ ...base, coutEstime: 999, toursAujourdhui: 999, plafonds: sans }) === null, "aucun refus");
});

cas("priorité : émetteur inconnu l'emporte sur un dépassement", () => {
  const r = motifRefus({ ...base, de: "inconnu", profondeur: 99, idsTraites: ["m1"] });
  assert(r.silencieux === true && r.motif.includes("inconnu"), "émetteur d'abord");
});

cas("helpers élémentaires", () => {
  assert(expediteurEcoute("maison", ["maison"]) === true, "écouté");
  assert(expediteurEcoute("x", ["maison"]) === false, "pas écouté");
  assert(dejaTraite("a", ["a", "b"]) === true, "déjà traité");
  assert(dejaTraite("c", ["a", "b"]) === false, "pas traité");
  assert(profondeurSuivante(2) === 3, "profondeur +1");
  assert(filDoitSArreter(6, 6) === true, "arrêt au plafond");
  assert(filDoitSArreter(5, 6) === false, "continue sous le plafond");
});

console.log(`veilleurPolitique : ${ok} cas OK`);
