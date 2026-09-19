/*
 * T-087 — ce que `captureUsageSnapshot` accepte d'appeler « un relevé ».
 *
 * Le défaut qui a motivé ce fichier n'était pas une exception ni une forme
 * inattendue : la méthode d'usage répondait CORRECTEMENT, avec
 * `rate_limits_available: true` et `subscription_type: "max"`, mais des
 * `rate_limits` encore vides — l'abonnement s'applique, le point d'usage n'a
 * pas répondu. Rien dans le code ne distinguait cette réponse d'un relevé, et
 * elle écrasait le dernier connu partout à la fois (dépôt, cache disque de
 * l'encart, historique `claude-windows.jsonl`, entrée du routeur).
 *
 * Un test de bout en bout n'aurait pas tenu cette garantie : il faut fabriquer
 * la réponse à la milliseconde près. D'où l'exercice direct de la fonction.
 *
 * Lancement isolé : node sidecar/test/captureUsage.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { captureUsageSnapshot, releveExploitable } = await import(moduleCompile("claudeUsage.js"));

/** Faux `query` réduit à ce que la capture consomme : la méthode d'usage. */
function query(reponse) {
  return {
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return reponse;
    },
  };
}

const CINQ_H = { utilization: 42, resets_at: "2026-08-21T18:40:00.303048+00:00" };
const SEPT_J = { utilization: 80, resets_at: "2026-08-22T18:00:00.303075+00:00" };

async function testReleveComplet() {
  const snap = await captureUsageSnapshot(
    query({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { five_hour: CINQ_H, seven_day: SEPT_J },
    }),
  );
  assert(snap !== null, "un relevé chiffré doit être rendu");
  assert(snap.available === true, `available attendu true, reçu ${JSON.stringify(snap)}`);
  assert(snap.subscriptionType === "max", `subscriptionType incorrect : ${snap.subscriptionType}`);
  assert(snap.fiveHour?.utilization === 42, `fiveHour incorrect : ${JSON.stringify(snap.fiveHour)}`);
  assert(snap.sevenDay?.utilization === 80, `sevenDay incorrect : ${JSON.stringify(snap.sevenDay)}`);
  assert(
    snap.windows.five_hour?.resetsAt === CINQ_H.resets_at,
    `windows.five_hour incorrect : ${JSON.stringify(snap.windows)}`,
  );
  assert(typeof snap.capturedAt === "string" && snap.capturedAt.length > 0, "capturedAt manquant");
}

/*
 * LE cas du ticket, dans ses trois formes réelles : la réponse est bien formée
 * et annonce un abonnement, mais aucune fenêtre n'est chiffrée. Ce n'est pas
 * une mesure — donc pas de relevé, donc l'appelant garde le sien.
 */
async function testReponsesSansFenetre() {
  const formes = [
    { etiquette: "rate_limits absent", rate_limits: null },
    { etiquette: "rate_limits vide", rate_limits: {} },
    {
      etiquette: "fenêtres présentes mais non chiffrées",
      rate_limits: { five_hour: null, seven_day: { utilization: null, resets_at: null } },
    },
  ];
  for (const forme of formes) {
    const snap = await captureUsageSnapshot(
      query({ subscription_type: "max", rate_limits_available: true, rate_limits: forme.rate_limits }),
    );
    assert(snap === null, `« ${forme.etiquette} » n'est pas un relevé, reçu ${JSON.stringify(snap)}`);
  }
}

/* `extra_usage` porte une `utilization` — en euros dépensés, pas en quota. */
async function testExtraUsageNestPasUneFenetre() {
  const snap = await captureUsageSnapshot(
    query({
      rate_limits_available: true,
      rate_limits: { extra_usage: { is_enabled: true, utilization: 12 } },
    }),
  );
  assert(snap === null, `extra_usage seul ne fait pas un relevé, reçu ${JSON.stringify(snap)}`);
}

/* Fenêtres hebdo par modèle : clé directe ET tableau `model_scoped`. */
async function testFenetresDeModele() {
  const snap = await captureUsageSnapshot(
    query({
      rate_limits_available: true,
      rate_limits: {
        five_hour: CINQ_H,
        seven_day: SEPT_J,
        seven_day_opus: { utilization: 7, resets_at: SEPT_J.resets_at },
        model_scoped: [
          { display_name: "Fable", utilization: 49, resets_at: SEPT_J.resets_at },
          { display_name: "Sans chiffre", utilization: null, resets_at: null },
          { utilization: 3, resets_at: SEPT_J.resets_at },
        ],
      },
    }),
  );
  assert(snap !== null, "relevé attendu");
  assert(snap.windows.seven_day_opus?.utilization === 7, `clé directe perdue : ${JSON.stringify(snap.windows)}`);
  assert(
    snap.windows.Fable?.utilization === 49 && snap.windows.Fable?.resetsAt === SEPT_J.resets_at,
    `model_scoped non relayé : ${JSON.stringify(snap.windows)}`,
  );
  assert(
    !("Sans chiffre" in snap.windows) && Object.keys(snap.windows).length === 4,
    `fenêtres non chiffrées ou anonymes relayées à tort : ${JSON.stringify(snap.windows)}`,
  );
}

/* Les cas déjà couverts par la forme du SDK, gardés au même endroit. */
async function testFormesDegradees() {
  assert((await captureUsageSnapshot({})) === null, "SDK sans méthode d'usage → null");
  assert((await captureUsageSnapshot(query(null))) === null, "réponse non-objet → null");
  assert(
    (await captureUsageSnapshot(query({ rate_limits_available: false, rate_limits: null }))) === null,
    "clé API (limites hors sujet) → null",
  );
  assert(
    (await captureUsageSnapshot({
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        throw new Error("ProcessTransport is not ready for writing");
      },
    })) === null,
    "méthode qui lève → null, jamais de propagation",
  );
  assert(releveExploitable(null) === false, "null n'est pas un relevé");
}

await lancer(
  "captureUsageSnapshot",
  testReleveComplet,
  testReponsesSansFenetre,
  testExtraUsageNestPasUneFenetre,
  testFenetresDeModele,
  testFormesDegradees,
);
