// Tests du contrat émotion → visage. Valeurs attendues GRAVÉES (jamais
// recalculées avec la fonction testée). Lancer : node --test tools/avatar-proto/emotions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMOTIONS, decouperBalises, rapprocher, indexPose } from "./emotions.js";

test("balises : découpage en segments avec l'émotion de chacun", () => {
  assert.deepEqual(decouperBalises("[joie] Super ! [réflexion] Voyons ça…"), [
    { emotion: "joie", texte: "Super !" },
    { emotion: "reflexion", texte: "Voyons ça…" },
  ]);
});

test("balises : le texte avant la première balise garde l'émotion initiale", () => {
  assert.deepEqual(decouperBalises("Bonjour. [Colère] Non.", "tristesse"), [
    { emotion: "tristesse", texte: "Bonjour." },
    { emotion: "colere", texte: "Non." },
  ]);
});

test("balises : une balise inconnue n'est ni lue ni appliquée", () => {
  assert.deepEqual(decouperBalises("[joie] Oui [perplexe] et non"), [
    { emotion: "joie", texte: "Oui" },
    { emotion: "joie", texte: "et non" },
  ]);
});

test("balises : réponse sans texte → aucun segment", () => {
  assert.deepEqual(decouperBalises("[joie]  [peur] "), []);
});

test("rapprocher : une constante de temps ramène à 1 - 1/e de la cible", () => {
  // vitesse 6/s, dt 1/6 s → k = 1 - e^-1 ≈ 0,632
  const r = rapprocher({}, { jawOpen: 1 }, 1 / 6, 6);
  assert.ok(Math.abs(r.jawOpen - 0.632) < 0.001, `obtenu ${r.jawOpen}`);
});

test("rapprocher : une pose absente de la cible retombe vers 0 puis disparaît", () => {
  let r = { mouthSmile_L: 0.7 };
  for (let i = 0; i < 200; i++) r = rapprocher(r, {}, 0.05, 6);
  assert.deepEqual(r, {});
});

test("toutes les poses utilisées sont des noms ARKit valides et bornés", () => {
  // Liste ARKit de référence (52 noms) — un nom mal orthographié serait
  // ignoré en silence par le rendu, d'où ce garde-fou.
  const ARKIT = new Set(("browInnerUp browDown_L browDown_R browOuterUp_L browOuterUp_R eyeLookUp_L eyeLookUp_R " +
    "eyeLookDown_L eyeLookDown_R eyeLookIn_L eyeLookIn_R eyeLookOut_L eyeLookOut_R eyeBlink_L eyeBlink_R " +
    "eyeSquint_L eyeSquint_R eyeWide_L eyeWide_R cheekPuff cheekSquint_L cheekSquint_R noseSneer_L noseSneer_R " +
    "jawOpen jawForward jawLeft jawRight mouthFunnel mouthPucker mouthLeft mouthRight mouthRollUpper " +
    "mouthRollLower mouthShrugUpper mouthShrugLower mouthClose mouthSmile_L mouthSmile_R mouthFrown_L " +
    "mouthFrown_R mouthDimple_L mouthDimple_R mouthUpperUp_L mouthUpperUp_R mouthLowerDown_L mouthLowerDown_R " +
    "mouthPress_L mouthPress_R mouthStretch_L mouthStretch_R tongueOut").split(" "));
  assert.equal(ARKIT.size, 52);
  for (const [nom, poses] of Object.entries(EMOTIONS)) {
    for (const [pose, poids] of Object.entries(poses)) {
      assert.ok(ARKIT.has(pose), `${nom} : pose inconnue ${pose}`);
      assert.ok(poids > 0 && poids <= 0.9, `${nom}.${pose} = ${poids}`);
    }
  }
});

test("indexPose : accepte les deux conventions de latéralisation", () => {
  const rpm = { jawOpen: 3, mouthSmileLeft: 7, mouthSmileRight: 8 };
  assert.equal(indexPose(rpm, "mouthSmile_L"), 7);
  assert.equal(indexPose(rpm, "mouthSmile_R"), 8);
  assert.equal(indexPose(rpm, "jawOpen"), 3);
  assert.equal(indexPose({ mouthSmile_L: 2 }, "mouthSmile_L"), 2);
  assert.equal(indexPose(rpm, "eyeBlink_L"), undefined);
});
