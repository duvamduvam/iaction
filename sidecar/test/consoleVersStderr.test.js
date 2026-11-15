/*
 * T-170 — les traces `console.log` des bibliothèques ne doivent jamais tomber
 * sur la sortie standard du sidecar (canal du protocole JSON).
 *
 * Lancement isolé : node sidecar/test/consoleVersStderr.test.js
 */

import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { redirigerConsoleVersStderr } = await import(moduleCompile("consoleVersStderr.js"));

function fluxMemoire() {
  const morceaux = [];
  const flux = new Writable({
    write(chunk, _enc, cb) {
      morceaux.push(String(chunk));
      cb();
    },
  });
  return { flux, texte: () => morceaux.join("") };
}

await lancer("les méthodes de console qui écrivent sur stdout partent vers le flux d'erreur, et se rétablissent", async () => {
  const sortie = [];
  const faux = { log: (...a) => sortie.push(a), info: () => {}, debug: () => {}, table: () => {}, dir: () => {}, dirxml: () => {}, error: () => {}, warn: () => {} };
  const { flux, texte } = fluxMemoire();
  const retablir = redirigerConsoleVersStderr(faux, flux);
  faux.log("[BrowserSSETransport] Dropping control_request from source=client");
  faux.info("info %s", "x");
  faux.debug("debug");
  assert(sortie.length === 0, "rien n'est écrit par la méthode d'origine");
  const t = texte();
  assert(t.includes("[BrowserSSETransport] Dropping control_request from source=client\n"), `log redirigé : ${JSON.stringify(t)}`);
  assert(t.includes("info x\n") && t.includes("debug\n"), "info et debug aussi");
  retablir();
  faux.log("retour");
  assert(sortie.length === 1, "méthode d'origine rétablie");
});

await lancer("dans un process réel : console.log n'atteint pas stdout, process.stdout.write (protocole) si", async () => {
  const module = moduleCompile("consoleVersStderr.js");
  const code = `
    import(${JSON.stringify(module)}).then((m) => {
      m.redirigerConsoleVersStderr();
      console.log("trace de bibliothèque");
      process.stdout.write(JSON.stringify({ event: "ready" }) + "\\n");
    });`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert(r.status === 0, `code de sortie ${r.status} : ${r.stderr}`);
  assert(r.stdout === '{"event":"ready"}\n', `stdout ne porte que le protocole : ${JSON.stringify(r.stdout)}`);
  assert(r.stderr.includes("trace de bibliothèque"), "la trace est sur stderr");
});
