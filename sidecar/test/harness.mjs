/*
 * Socle des tests du sidecar.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * Jusqu'au 2026-08-08, tous les tests du protocole vivaient dans un seul
 * fichier de 6 000 lignes. Ce n'était pas un excès de zèle : le harnais
 * (lancer un sidecar, lui parler en JSON Lines, attendre un événement) n'était
 * défini nulle part ailleurs, donc tout nouveau test devait naître à côté des
 * précédents pour en profiter. La taille du fichier était la CONSÉQUENCE de
 * l'absence de socle, pas la cause.
 *
 * Ce module est ce socle. Chaque fichier de test peut désormais vivre seul, et
 * se lancer seul — ce qui rend enfin lisible ce qui est couvert et ce qui ne
 * l'est pas.
 *
 * Règle : rien ici ne connaît un domaine particulier. Un helper qui parle de
 * tâches, de MCP ou d'orchestration appartient au fichier de son domaine.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const dossierTest = path.dirname(fileURLToPath(import.meta.url));

/**
 * Point d'entrée du sidecar compilé.
 *
 * Le DÉFAUT est `dist-verif/` — jamais `dist/`. Ce n'est pas un confort :
 * réécrire `sidecar/dist/` pendant que l'application tourne tue le sidecar de
 * la session en cours — constaté trois fois le 2026-08-07, puis une QUATRIÈME
 * le 2026-08-08, parce que `dist-verif` n'était alors qu'une option
 * (IACTION_TEST_ENTRY) et que le chemin par défaut restait le dangereux.
 * Depuis : `npm test -w sidecar` compile ET lit `dist-verif/`, et `dist/`
 * n'est écrit que par `sidecar:build` (empaquetage, dev.sh).
 */
export const entry = process.env.IACTION_TEST_ENTRY ?? path.join(dossierTest, "..", "dist-verif", "index.js");

/**
 * URL d'un module compilé du sidecar, pour les tests qui l'importent
 * directement au lieu de passer par le protocole.
 *
 * Dérivée de `entry`, et non recalculée depuis `__dirname` : sans cela, la
 * moitié de la suite viserait `dist/` pendant que l'autre viserait la
 * compilation de test, et on croirait vérifier un build qu'on ne vérifie pas.
 */
export function moduleCompile(nom) {
  return pathToFileURL(path.join(path.dirname(entry), nom)).href;
}

export const fakeClaudeModule = path.join(dossierTest, "fakeClaude.mjs");
export const fakeClaudeWithUsageModule = path.join(dossierTest, "fakeClaudeWithUsage.mjs");
export const fakeClaudeMcpModule = path.join(dossierTest, "fakeClaudeMcp.mjs");

/**
 * Répertoire de configuration jetable, imposé AVANT que le moindre test ne
 * démarre un sidecar.
 *
 * Chaque tour terminé écrit un événement d'usage sous
 * `XDG_CONFIG_HOME/net.duvam.iaction/usage/`. La plupart des spawns héritent de
 * `process.env` sans redéfinir cette variable : sans ce défaut, la suite
 * écrirait dans le vrai `~/.config` de la machine qui la lance.
 */
export const defaultXdgConfigHome = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-xdg-"));
process.env.XDG_CONFIG_HOME = defaultXdgConfigHome;

export function fail(message) {
  console.error(`ECHEC: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

export function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collecteur d'événements en-process pour un EngineEmitter (chunk/done/error),
 * avec un `waitFor` de même forme que celui du harnais sous-processus.
 */
export function makeEmitterCollector() {
  const events = [];
  const waiters = [];

  function notify(evt) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  const emitter = {
    chunk(id, data) {
      const evt = { kind: "chunk", id, data };
      events.push(evt);
      notify(evt);
    },
    done(id, data) {
      const evt = { kind: "done", id, data };
      events.push(evt);
      notify(evt);
    },
    error(id, message) {
      const evt = { kind: "error", id, data: { message } };
      events.push(evt);
      notify(evt);
    },
  };

  function waitFor(predicate, timeoutMs = 3000, label = "événement") {
    const existing = events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters.push(w);
    });
  }

  return { emitter, events, waitFor };
}

/**
 * StepRunner factice contrôlable par scénario
 * (`behaviors: {[stepId]: {mode:"success"|"fail"|"hang", output?, message?}}`).
 * Enregistre la concurrence observée (start() simultanés en cours) et le prompt
 * vu par chaque étape (pour vérifier le templating) — consommés par les
 * assertions du test appelant.
 */
export function makeFakeStepRunner(behaviors) {
  const hangers = new Map(); // internalId -> {resolve, emitter}
  const seenPrompts = {};
  const concurrency = { current: 0, max: 0 };

  const runner = {
    async start(internalId, _engine, params, emitter) {
      const stepId = internalId.slice(internalId.lastIndexOf("::") + 2);
      const behavior = behaviors[stepId] || { mode: "success" };
      seenPrompts[stepId] = params.prompt;

      concurrency.current++;
      concurrency.max = Math.max(concurrency.max, concurrency.current);
      emitter.chunk(internalId, { kind: "text", delta: `hello-${stepId}` });

      if (behavior.mode === "hang") {
        await new Promise((resolve) => {
          hangers.set(internalId, { resolve, emitter });
        });
        concurrency.current--;
        return;
      }

      await sleep(15);
      concurrency.current--;

      if (behavior.mode === "fail") {
        emitter.done(internalId, { subtype: "error_x", result: null, usage: null });
      } else {
        const output = behavior.output ?? `output-${stepId}`;
        emitter.done(internalId, { subtype: "success", result: output, usage: { inputTokens: 1, outputTokens: 1 } });
      }
    },
    async permission(_engine, id, _params, emitter) {
      emitter.done(id, { applied: false });
    },
    async abort(_engine, _id, params, _emitter) {
      const h = hangers.get(params.targetId);
      if (h) {
        hangers.delete(params.targetId);
        h.emitter.done(params.targetId, { subtype: "aborted", result: null, usage: null });
        h.resolve();
      }
    },
  };

  return { runner, seenPrompts, concurrency };
}

/**
 * Enchaîne les blocs d'un fichier de test et rend un compte rendu uniforme.
 *
 * Le code de sortie est la seule chose qui compte : une suite s'arrête au
 * premier échec, donc compter les lignes « OK » affichées fait passer un
 * fichier cassé pour un fichier court. C'est exactement l'erreur qui a laissé
 * partir un commit avec un test mort le 2026-08-07.
 */
export async function lancer(titre, ...tests) {
  const debut = Date.now();
  try {
    for (const test of tests) await test();
    const duree = ((Date.now() - debut) / 1000).toFixed(1);
    console.log(`\n✓ ${titre} — ${tests.length} bloc(s), ${duree} s`);
  } catch (err) {
    console.error(`\n✗ ${titre} — ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    await fsp.rm(defaultXdgConfigHome, { recursive: true, force: true }).catch(() => {});
  }
}
