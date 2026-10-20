/*
 * T-137 — `claude.sessionTitles` répond TOUJOURS, même si le SDK traîne.
 *
 * Le module promettait « jamais bloquant » ; la promesse n'était tenue que
 * pour les exceptions. `await sdk.listSessions(...)` n'avait aucune borne :
 * une lenteur — et non une panne — laissait la requête sans réponse pour
 * toujours. C'est ce qui a fait tomber la construction Windows de la 0.6.0,
 * où le premier import du SDK dépasse 5 s.
 *
 * On force ici la borne à 1 ms par l'environnement : le SDK ne peut pas
 * répondre plus vite, donc c'est le repli qui est exercé, à coup sûr et sans
 * attendre. Un test qui se contenterait d'espérer la lenteur ne prouverait
 * rien.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { lancer, assert, entry, fail } from "./harness.mjs";

async function testBorneListSessions() {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IACTION_SESSION_TITLES_TIMEOUT_MS: "1" },
  });
  const evenements = [];
  createInterface({ input: child.stdout }).on("line", (ligne) => {
    try {
      evenements.push(JSON.parse(ligne));
    } catch {
      /* lignes non JSON : ignorées */
    }
  });
  const attendre = (predicat, delai, quoi) =>
    new Promise((resolve, reject) => {
      const debut = Date.now();
      const tic = setInterval(() => {
        const trouve = evenements.find(predicat);
        if (trouve) {
          clearInterval(tic);
          resolve(trouve);
        } else if (Date.now() - debut > delai) {
          clearInterval(tic);
          reject(new Error(`timeout en attendant ${quoi}`));
        }
      }, 20);
    });

  let projet = null;
  try {
    projet = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-borne-titres-"));
    child.stdin.write(
      `${JSON.stringify({ id: "b1", method: "claude.sessionTitles", params: { cwd: projet } })}\n`,
    );
    const debut = Date.now();
    const rep = await attendre((e) => e.id === "b1" && (e.event === "done" || e.event === "error"), 10000, "b1");
    const ecoule = Date.now() - debut;
    assert(rep.event === "done", `b1 doit rendre 'done', jamais 'error' — reçu '${rep.event}'`);
    assert(
      JSON.stringify(rep.data.titles) === "[]",
      `b1 : repli {titles:[]} attendu, reçu ${JSON.stringify(rep.data)}`,
    );
    assert(ecoule < 5000, `b1 : la borne doit répondre vite, ${ecoule} ms écoulées`);
    console.log(`OK: borne à 1 ms ⇒ done {titles:[]} en ${ecoule} ms, jamais d'attente sans fin`);
  } catch (err) {
    fail(String(err && err.message ? err.message : err));
  } finally {
    child.kill();
    if (projet) await fsp.rm(projet, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer("T-137 — claude.sessionTitles borné", testBorneListSessions);
