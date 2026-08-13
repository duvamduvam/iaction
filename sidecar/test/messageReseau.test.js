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
