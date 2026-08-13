/*
 * Fonctions pures du moteur Claude (sidecar/src/claude.ts).
 *
 * Premier test unitaire de ce module de 1 800 lignes : jusqu'ici il n'était
 * exercé qu'au travers du protocole, avec un faux SDK. Les fonctions visées
 * sont celles de la famille du bug le plus visible du produit — la jauge de
 * contexte — plus les messages d'erreur décorés que l'utilisateur lit.
 *
 * Lancement isolé : node sidecar/test/claudePur.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const {
  decorateAuthError,
  extractContextTokens,
  extractUsage,
  summarizeToolResult,
} = await import(moduleCompile("claude.js"));
// Étape 9 : sessionTitles, commands et usage ont quitté claude.ts.
const { isFallbackTitle } = await import(moduleCompile("claudeSessionTitles.js"));
const { executerClaudeUsage } = await import(moduleCompile("claudeUsage.js"));
const { executerClaudeCommands } = await import(moduleCompile("claudeCommands.js"));

async function testExtractUsage() {
  // Le SDK parle snake_case (héritage API Anthropic) : la traduction est ici.
  const u = extractUsage({ input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56 });
  assert(u.inputTokens === 12 && u.outputTokens === 34 && u.cacheReadInputTokens === 56,
    `extractUsage : traduction snake_case attendue, reçu ${JSON.stringify(u)}`);

  // Champ cache absent : la propriété est ABSENTE, pas 0 — l'UI distingue
  // « pas de cache » de « cache vide » pour l'affichage du coût.
  const sans = extractUsage({ input_tokens: 1, output_tokens: 2 });
  assert(!("cacheReadInputTokens" in sans), "extractUsage : cache absent ⇒ propriété absente");

  // Usage non-objet : null, jamais un objet à zéros (un zéro n'est pas une mesure).
  assert(extractUsage(null) === null && extractUsage("x") === null && extractUsage([1]) === null,
    "extractUsage : entrée invalide ⇒ null");
  console.log("OK: extractUsage — snake_case, cache opt-in, invalide ⇒ null");
}

async function testExtractContextTokens() {
  // La jauge : prompt du DERNIER appel = frais + cache relu + cache créé.
  assert(extractContextTokens({ input_tokens: 1000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000 }) === 153000,
    "extractContextTokens : somme des trois composantes du prompt");

  // La régression du 2026-08-07 : un usage à zéros N'EST PAS une mesure.
  // La renvoyer comme 0 affichait « 0 % » après compaction.
  assert(extractContextTokens({ input_tokens: 0, output_tokens: 0 }) === null,
    "extractContextTokens : total nul ⇒ null (un zéro n'est pas une mesure)");

  // output_tokens ne compte JAMAIS : la sortie ne vit pas dans la fenêtre
  // d'entrée, et elle est ré-incluse dans le cache_read de l'appel suivant —
  // l'additionner la compterait double (jauge à ~140 %).
  assert(extractContextTokens({ input_tokens: 100, output_tokens: 99999 }) === 100,
    "extractContextTokens : output_tokens ignoré");

  assert(extractContextTokens(null) === null && extractContextTokens("x") === null,
    "extractContextTokens : entrée invalide ⇒ null");
  console.log("OK: extractContextTokens — somme du prompt, zéro ⇒ null, sortie ignorée");
}

async function testDecorateAuthError() {
  // Limite d'abonnement ≠ défaut d'authentification : conseiller « claude
  // login » à un utilisateur à quota épuisé l'envoie déboguer le mauvais
  // problème. L'ordre des tests dans la fonction est donc significatif.
  const limite = decorateAuthError("Usage limit reached for your plan");
  assert(limite.includes("limite d'abonnement") && !limite.includes("claude login"),
    `limite : conseil de jauge attendu, reçu « ${limite} »`);

  const auth = decorateAuthError("Invalid API key provided");
  assert(auth.includes("claude login"),
    `auth : conseil de connexion attendu, reçu « ${auth} »`);

  // « rate limit » contient « limit » ET arrive souvent avec des mots d'auth
  // autour : il doit tomber côté abonnement.
  assert(decorateAuthError("API rate limit exceeded, check your auth").includes("limite d'abonnement"),
    "rate limit ⇒ abonnement, même si le message parle aussi d'auth");

  const brut = "ECONNREFUSED 127.0.0.1:443";
  assert(decorateAuthError(brut) === brut, "message hors des deux familles : rendu tel quel");
  console.log("OK: decorateAuthError — limite ≠ auth, priorité à la limite");
}

async function testSummarizeToolResult() {
  assert(summarizeToolResult("court") === "court", "chaîne courte rendue telle quelle");

  // Blocs SDK : les textes sont joints, les blocs muets sérialisés.
  const blocs = summarizeToolResult([{ text: "a" }, { type: "image" }, { text: "b" }]);
  assert(blocs === 'a\n{"type":"image"}\nb', `blocs : jointure attendue, reçu ${JSON.stringify(blocs)}`);

  assert(summarizeToolResult(null) === "" && summarizeToolResult(undefined) === "",
    "null/undefined ⇒ chaîne vide");

  // Troncature : borne stricte, marquée par une ellipse.
  const long = summarizeToolResult("x".repeat(100000));
  assert(long.length < 100000 && long.endsWith("…"), "résultat long tronqué avec ellipse");

  // Référence circulaire : String() de secours, jamais d'exception — un outil
  // qui rend n'importe quoi ne doit pas tuer le tour.
  const boucle = {}; boucle.moi = boucle;
  assert(typeof summarizeToolResult(boucle) === "string", "objet circulaire ⇒ pas d'exception");
  console.log("OK: summarizeToolResult — blocs, troncature, circulaire");
}

async function testIsFallbackTitle() {
  // Le SDK tronque parfois summary : comparaison par PRÉFIXE, pas égalité.
  assert(isFallbackTitle("Corrige le bug de", "Corrige le bug de la jauge de contexte") === true,
    "summary tronqué du premier prompt ⇒ repli");
  assert(isFallbackTitle("Réparation de la jauge", "Corrige le bug de la jauge") === false,
    "vrai titre IA ⇒ pas un repli");
  assert(isFallbackTitle("Corrige", undefined) === false, "sans premier prompt ⇒ jamais un repli");
  assert(isFallbackTitle("   ", "Corrige") === false, "candidat vide ⇒ pas un repli");
  console.log("OK: isFallbackTitle — préfixe, pas égalité stricte");
}


async function testExecuterClaudeUsage() {
  // Étape 9 — le dépôt injecté est la SEULE source : pas d'instantané ⇒
  // {available:false}, jamais une erreur ; un instantané ⇒ copie défensive.
  const emis = [];
  const emitter = { done: (id, data) => emis.push({ id, data }), error: () => emis.push("ERREUR") };
  executerClaudeUsage({ lire: () => null, ecrire: () => {} }, "u1", {}, emitter);
  assert(emis.length === 1 && emis[0].data.available === false,
    `sans instantané : {available:false} attendu, reçu ${JSON.stringify(emis)}`);

  const instantane = { available: true, subscriptionType: "max", fiveHour: null, sevenDay: null, windows: {}, capturedAt: "t" };
  executerClaudeUsage({ lire: () => instantane, ecrire: () => {} }, "u2", {}, emitter);
  assert(emis[1].data.subscriptionType === "max" && emis[1].data !== instantane,
    "l'instantané est servi en COPIE (spread), jamais l'objet du dépôt");
  console.log("OK: executerClaudeUsage — dépôt injecté, copie défensive");
}

async function testExecuterClaudeCommands() {
  // Étape 9 — le moteur est injecté : un faux queryFn suffit à vérifier le
  // mapping des commandes ET que la session est refermée (interrupt).
  let interrompu = false;
  const fauxQuery = {
    supportedCommands: async () => [
      { name: "compact", description: "Résume", argumentHint: "", aliases: ["c"] },
      { name: "nue", description: undefined, argumentHint: undefined },
    ],
    interrupt: async () => {
      interrompu = true;
    },
  };
  const emis = [];
  const emitter = { done: (id, data) => emis.push(data), error: (id, msg) => emis.push(`ERR:${msg}`) };
  await executerClaudeCommands(
    { queryFn: () => fauxQuery, apiKey: () => null, decorerErreurAuth: (m) => m },
    "c1",
    { cwd: "/tmp" },
    emitter,
  );
  assert(interrompu, "la session à vide doit être refermée (interrupt)");
  assert(
    JSON.stringify(emis[0].commands) ===
      JSON.stringify([
        { name: "compact", description: "Résume", argumentHint: "", aliases: ["c"] },
        { name: "nue", description: "", argumentHint: "" },
      ]),
    `mapping des commandes inattendu : ${JSON.stringify(emis[0])}`,
  );

  // cwd manquant : erreur protocolaire propre, pas de spawn.
  const emis2 = [];
  await executerClaudeCommands(
    { queryFn: () => { throw new Error("ne doit pas être appelé"); }, apiKey: () => null, decorerErreurAuth: (m) => m },
    "c2",
    {},
    { done: () => emis2.push("done"), error: (id, msg) => emis2.push(msg) },
  );
  assert(emis2.length === 1 && String(emis2[0]).includes("cwd"), `erreur cwd attendue, reçu ${JSON.stringify(emis2)}`);
  console.log("OK: executerClaudeCommands — deps injectées, session refermée");
}

await lancer(
  "moteur Claude — fonctions pures",
  testExtractUsage,
  testExtractContextTokens,
  testDecorateAuthError,
  testSummarizeToolResult,
  testIsFallbackTitle,
  testExecuterClaudeUsage,
  testExecuterClaudeCommands,
);
