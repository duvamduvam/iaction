/*
 * T-118 — classer une erreur du moteur Claude.
 *
 * Le cas fondateur est celui du poste Windows du 2026-09-02 : « API Error:
 * Unable to connect to API (ConnectionRefused) », affiché brut, dont
 * l'utilisateur a conclu « l'application ne marche pas ». Le diagnostic a
 * montré un incident réseau transitoire — ni l'app, ni un certificat, ni un
 * proxy. Ce fichier verrouille le fait que les quatre familles ne se
 * confondent pas : elles portent quatre gestes différents.
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { classerErreurClaude, decorerErreurClaude, texteMessageAssistant } = await import(
  moduleCompile("diagnosticErreurClaude.js")
);

function testCasWindows() {
  const brut = "API Error: Unable to connect to API (ConnectionRefused)";
  assert(classerErreurClaude(brut) === "reseau", `réseau attendu, reçu ${classerErreurClaude(brut)}`);
  const decore = decorerErreurClaude(brut);
  assert(decore.startsWith(brut), "le message brut doit rester en tête — il reste la vérité terrain");
  assert(decore.includes("injoignable"), `la cause doit être nommée, reçu « ${decore} »`);
  assert(
    !decore.includes("claude login"),
    "surtout PAS de conseil de reconnexion : c'est le mauvais problème (T-118)",
  );
  console.log("OK: 'Unable to connect to API (ConnectionRefused)' → réseau, sans conseil d'auth");
}

function testTlsPrimeSurReseau() {
  // Le message d'août portait les DEUX vocabulaires ; le geste utile est TLS.
  const brut = "API Error: Unable to connect to API: SSL certificate hostname mismatch";
  assert(classerErreurClaude(brut) === "tls", `tls attendu, reçu ${classerErreurClaude(brut)}`);
  assert(decorerErreurClaude(brut).includes("interceptée"), "la piste antivirus/proxy doit être nommée");
  console.log("OK: 'SSL certificate hostname mismatch' → tls, et non réseau");
}

function testAbonnementPrimeSurTout() {
  assert(classerErreurClaude("Usage limit reached for your plan") === "abonnement");
  assert(
    classerErreurClaude("API rate limit exceeded, check your auth") === "abonnement",
    "« rate limit » entouré de mots d'auth doit rester abonnement",
  );
  console.log("OK: la limite d'abonnement prime sur les autres familles");
}

function testAuthentification() {
  const decore = decorerErreurClaude("Invalid API key provided");
  assert(classerErreurClaude("Invalid API key provided") === "authentification");
  assert(decore.includes("claude login"), "le conseil de connexion est attendu ici, et ici seulement");
  console.log("OK: 'Invalid API key' → authentification");
}

function testInconnueRenduTelQuel() {
  // T-103 — un conseil faux est pire qu'un conseil absent.
  const brut = "Something went sideways in the engine";
  assert(classerErreurClaude(brut) === "inconnue");
  assert(decorerErreurClaude(brut) === brut, "un message non classé est rendu TEL QUEL");
  console.log("OK: message non classable → rendu tel quel, aucun conseil inventé");
}

function testAutresSignaturesReseau() {
  for (const m of [
    "ECONNREFUSED 127.0.0.1:443",
    "UND_ERR_CONNECT_TIMEOUT",
    "erreur réseau: fetch failed",
    "getaddrinfo ENOTFOUND api.anthropic.com",
  ]) {
    assert(classerErreurClaude(m) === "reseau", `réseau attendu pour « ${m} », reçu ${classerErreurClaude(m)}`);
  }
  console.log("OK: les signatures réseau du CLI, de Node et d'undici tombent toutes côté réseau");
}

function testImageRefusee() {
  // T-144 — constat du 2026-09-27 : session empoisonnée par une capture 2464×1508.
  const brut =
    "API Error: an image in the conversation could not be processed and was removed. Re-read the file with a different approach if you still need it.";
  assert(classerErreurClaude(brut) === "image", `image attendu, reçu ${classerErreurClaude(brut)}`);
  const decore = decorerErreurClaude(brut);
  assert(decore.startsWith(brut), "le message brut reste en tête");
  assert(decore.includes("NOUVELLE session"), `le geste (nouvelle session) doit être nommé, reçu « ${decore} »`);
  assert(!decore.includes("claude login"), "surtout pas de conseil de reconnexion");
  assert(texteMessageAssistant({ model: "<synthetic>" }, brut) === decore, "message synthétique → décoré");
  assert(texteMessageAssistant({ model: "claude-opus-5-5" }, brut) === brut, "vrai message du modèle → intact");
  console.log("OK: image refusée → conseil de nouvelle session, seulement sur un message synthétique");
}

await lancer(
  "T-118 — classer une erreur du moteur Claude",
  testCasWindows,
  testTlsPrimeSurReseau,
  testAbonnementPrimeSurTout,
  testAuthentification,
  testInconnueRenduTelQuel,
  testAutresSignaturesReseau,
  testImageRefusee,
);
