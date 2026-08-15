/*
 * Le code de cause d'une panne réseau doit arriver jusqu'au journal (T-044).
 *
 * Ce que ces cas protègent tient en une phrase : `fetch` de Node rend TOUJOURS
 * le même message — « fetch failed » — et range la vraie cause dans
 * `err.cause.code`. Sans elle, un proxy, un certificat, un DNS et un service
 * éteint produisent la même ligne de journal. Le 2026-08-13, il a fallu piloter
 * un poste d'entreprise à distance pour obtenir `UND_ERR_CONNECT_TIMEOUT`,
 * c'est-à-dire un mot que le journal avait sous la main et n'écrivait pas.
 *
 * Lancement isolé : node sidecar/test/messageReseau.test.js
 */

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { avecCause, messageReseau } = await import(moduleCompile("base.js"));

/** L'erreur exacte que rend le fetch de Node derrière un proxy d'entreprise. */
function erreurFetchProxy() {
  const err = new Error("fetch failed");
  err.cause = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  return err;
}

await lancer("le code de cause remonte dans le message", async () => {
  const message = messageReseau(erreurFetchProxy());
  assert(message.includes("UND_ERR_CONNECT_TIMEOUT"), `cause absente : ${message}`);
  assert(message.startsWith("erreur réseau: fetch failed"), `préfixe perdu : ${message}`);
});

await lancer("les quatre pannes courantes se distinguent", async () => {
  const messages = ["ENOTFOUND", "ECONNREFUSED", "SELF_SIGNED_CERT_IN_CHAIN", "UND_ERR_CONNECT_TIMEOUT"].map(
    (code) => {
      const err = new Error("fetch failed");
      err.cause = Object.assign(new Error("x"), { code });
      return messageReseau(err);
    },
  );
  assert(new Set(messages).size === 4, `quatre causes doivent donner quatre messages : ${messages.join(" | ")}`);
});

await lancer("un code posé sur l'erreur elle-même est vu aussi", async () => {
  const err = Object.assign(new Error("getaddrinfo a échoué"), { code: "EAI_AGAIN" });
  assert(avecCause(err).includes("EAI_AGAIN"), avecCause(err));
});

await lancer("sans cause, le message reste tel quel", async () => {
  assert(messageReseau(new Error("boom")) === "erreur réseau: boom");
  assert(avecCause(new Error("boom")) === "boom");
});

await lancer("un code déjà présent dans le message n'est pas répété", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
  const message = avecCause(err);
  assert(message.split("ECONNREFUSED").length === 2, `code répété : ${message}`);
});

await lancer("ce qui n'est pas une Error ne fait pas tomber le journal", async () => {
  assert(messageReseau("juste une chaîne") === "erreur réseau: juste une chaîne");
  assert(messageReseau(null) === "erreur réseau: null");
  assert(typeof messageReseau({ code: "EPERM" }) === "string");
});

/*
 * ── Corps d'erreur : une page web n'est pas un diagnostic (T-007) ────────
 *
 * Le 2026-08-08, `ollama.ps` a reçu 24 fois le 404 HTML d'une plateforme
 * d'hébergement : l'adresse enregistrée pour ce fournisseur désignait un site
 * web. Chaque occurrence recopiait deux kilo-octets de balises dans le journal
 * — beaucoup de bruit pour un fait qui tient en une ligne.
 */

const { estPageHtml, estResumePageHtml, resumerCorpsHttp } = await import(moduleCompile("base.js"));

const PAGE_404 = `<!DOCTYPE html><html><head><title>404: NOT_FOUND</title>${"<div>x</div>".repeat(400)}</head></html>`;

await lancer("une page web reçue au lieu d'une API est résumée, pas recopiée", async () => {
  const resume = resumerCorpsHttp(PAGE_404, "text/html; charset=utf-8");
  assert(resume.includes("404: NOT_FOUND"), `le titre porte le diagnostic : ${resume}`);
  assert(resume.includes(String(PAGE_404.length)), `la taille dit que quelque chose a répondu : ${resume}`);
  assert(!resume.includes("<div>"), `aucune balise ne doit survivre : ${resume}`);
  assert(resume.length < 100, `le résumé doit rester court, reçu ${resume.length} caractères`);
  assert(estResumePageHtml(resume), "l'appelant doit pouvoir reconnaître le cas pour proposer un remède");
});

await lancer("l'en-tête suffit, la forme du corps aussi", async () => {
  // Aucun des deux indices ne suffit seul : un serveur mal configuré peut
  // taire son content-type, et un JSON peut contenir du HTML — mais pas dès
  // son premier caractère.
  assert(estPageHtml("<html><body>hop</body></html>", null), "forme du corps seule");
  assert(estPageHtml("n'importe quoi", "text/html"), "en-tête seul");
  assert(!estPageHtml('{"error":"<html> dans une chaîne"}', "application/json"), "un JSON n'est pas une page");
});

await lancer("un corps d'API en erreur passe intact, seulement borné", async () => {
  const json = '{"error":{"message":"quota dépassé"}}';
  assert(resumerCorpsHttp(json, "application/json") === json, "un petit JSON ne doit pas être touché");

  const enorme = "x".repeat(5000);
  const borne = resumerCorpsHttp(enorme, "application/json");
  assert(borne.length < 2100, `un corps énorme reste borné, reçu ${borne.length}`);
  assert(borne.endsWith("…"), "la troncature doit se voir");
  assert(!estResumePageHtml(borne), "un corps tronqué n'est pas une page web");
});
