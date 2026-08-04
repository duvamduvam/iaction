#!/usr/bin/env node
/**
 * Lanceur d'orchestration sans UI — spawn le sidecar, exécute une
 * orchestration (`orch.run`, voir docs/protocol.md § O3 et
 * docs/etude-orchestration.md § 6), relaie un résumé lisible sur stdout.
 *
 * Usage :
 *   node scripts/orch-run-headless.mjs <cwd-du-projet> <nom-orchestration> [--input clef=valeur ...] [--save-output fichier.md]
 *
 * Aucun fournisseur neutre n'est requis (les agents de l'orchestration
 * utilisent le moteur "claude" par défaut). Si <cwd>/providers.json existe
 * (format `{"providers":[...]}`, identique à `providers.set`), il est poussé
 * au sidecar avant `orch.run` — utile pour des orchestrations à agents
 * neutres (Ollama/OpenRouter/custom).
 *
 * Code de sortie : 0 si status "success", 2 si "partial", 1 sinon (failed,
 * aborted, erreur de résolution, timeout, crash du sidecar).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ENTRY = path.join(__dirname, "..", "sidecar", "dist", "index.js");
const GLOBAL_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_EXCERPT_MAX = 200;

function printUsage(stream = process.stderr) {
  stream.write(
    [
      "Usage : node scripts/orch-run-headless.mjs <cwd-du-projet> <nom-orchestration> [--input clef=valeur ...] [--save-output fichier.md]",
      "",
      "  <cwd-du-projet>     Répertoire du projet contenant l'orchestration (.iaction/orchestrations/<nom>.yaml).",
      "  <nom-orchestration> Nom de l'orchestration à exécuter.",
      "  --input clef=valeur Valeur d'un input déclaré par l'orchestration (répétable).",
      "  --save-output f.md  Écrit la sortie complète de chaque étape dans ce fichier (dossiers créés au besoin).",
      "",
      "Code de sortie : 0 (success), 2 (partial), 1 (failed/aborted/erreur).",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const positional = [];
  const inputs = {};
  let saveOutput = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--save-output") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--save-output attend un chemin de fichier.");
      }
      saveOutput = value;
    } else if (arg === "--input") {
      const pair = argv[++i];
      if (!pair || !pair.includes("=")) {
        throw new Error(`--input attend "clef=valeur", reçu : ${pair ?? "(rien)"}`);
      }
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!key) {
        throw new Error(`--input avec une clef vide : "${pair}"`);
      }
      inputs[key] = value;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 2) {
    throw new Error("arguments manquants : <cwd-du-projet> et <nom-orchestration> sont requis.");
  }
  const [cwd, name, ...rest] = positional;
  if (rest.length > 0) {
    throw new Error(`arguments positionnels en trop : ${rest.join(", ")}`);
  }
  return { cwd, name, inputs, saveOutput };
}

/**
 * Rapport déterministe : sorties complètes des étapes, écrites par le runner
 * lui-même — on ne dépend pas de la discipline du modèle pour matérialiser
 * un fichier (leçon de la première passe réelle du gardien-boites).
 */
async function saveRunOutput(filePath, result, meta) {
  const outPath = path.resolve(filePath);
  const lines = [
    `# Run « ${meta.name} » — ${meta.dateLabel}`,
    "",
    `- Projet : ${meta.cwd}`,
    `- Statut : ${result.status}`,
    "",
  ];
  for (const [stepId, info] of Object.entries(result.steps || {})) {
    lines.push(`## Étape ${stepId} — ${info.status}`, "");
    if (info.message) {
      lines.push(`> ${info.message}`, "");
    }
    lines.push(info.output ? info.output.trim() : "(aucune sortie)", "");
  }
  try {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, lines.join("\n"), "utf8");
    console.log(`[orch-run] sortie sauvegardée : ${outPath}`);
  } catch (err) {
    process.stderr.write(`[orch-run] échec d'écriture de ${outPath} : ${err.message}\n`);
  }
}

/** Date LOCALE `YYYY-MM-DD` — même convention que l'UI (« Lancer maintenant »). */
function localDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Résout le gabarit `{{today}}` (docs/protocol.md § T1) dans les valeurs
 * d'inputs et le chemin `--save-output` : le runner est « l'appelant » au sens
 * du contrat quand il est lancé par un timer systemd (unités T2 générées sans
 * substitution shell).
 */
function resolveTodayTemplates(inputs, saveOutput) {
  const today = localDateISO(new Date());
  const resolved = {};
  for (const [k, v] of Object.entries(inputs)) {
    resolved[k] = v.split("{{today}}").join(today);
  }
  return {
    inputs: resolved,
    saveOutput: saveOutput ? saveOutput.split("{{today}}").join(today) : saveOutput,
  };
}

function excerpt(text, max = OUTPUT_EXCERPT_MAX) {
  if (typeof text !== "string" || text.length === 0) return "";
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

async function loadProvidersFile(cwd) {
  const filePath = path.join(cwd, "providers.json");
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    process.stderr.write(`[orch-run] impossible de lire ${filePath} (${err.message}) — ignoré.\n`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.providers)) {
      process.stderr.write(`[orch-run] ${filePath} ne contient pas de tableau "providers" — ignoré.\n`);
      return null;
    }
    return parsed.providers;
  } catch (err) {
    process.stderr.write(`[orch-run] ${filePath} n'est pas un JSON valide (${err.message}) — ignoré.\n`);
    return null;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * R6-A — chemin du `config.json` NON SECRET de l'app : le MÊME fichier que le
 * config_store Tauri (src-tauri/src/config_store.rs lit `config.json` dans
 * l'app_config_dir de l'identifiant « net.duvam.iaction », soit
 * `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/config.json` sous
 * Linux — même convention que sidecar/src/usageStats.ts).
 */
function appConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = typeof xdg === "string" && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "net.duvam.iaction", "config.json");
}

/**
 * R6-A — paramètres du `router.set` poussé AVANT le run : les agents
 * `engine: auto` d'un run headless (timer nocturne) doivent suivre la même
 * table/config de routage que l'app. Clé racine `routing` du config.json
 * (cf. ui/src/routerAdmin.ts), relayée telle quelle : la validation souple
 * est côté sidecar, et `classifier`/`debord` peuvent valoir `null`
 * (= désactivé).
 *
 * GARDE-FOU : config illisible, absente ou sans clé `routing` exploitable →
 * `{table: {}, debord: null}`. Sans cela, les DÉFAUTS du sidecar
 * s'appliqueraient (débord vers OpenRouter, payant) : un run nocturne sans
 * configuration explicite ne doit JAMAIS déclencher de bascule payante
 * automatique.
 */
async function loadRouterSetParams() {
  let routing = null;
  try {
    const raw = await readFile(appConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed) && isPlainObject(parsed.routing)) {
      routing = parsed.routing;
    }
  } catch {
    routing = null;
  }
  if (!routing) {
    return { params: { table: {}, debord: null }, fromConfig: false };
  }
  const params = { table: isPlainObject(routing.table) ? routing.table : {} };
  for (const key of ["classifier", "debord", "embeddings"]) {
    if (key in routing) {
      params[key] = routing[key];
    }
  }
  return { params, fromConfig: true };
}

/**
 * Petit client JSON Lines par-dessus le sidecar : diffuse chaque événement
 * reçu à des observateurs (`onEvent`) et offre `waitFor`/`request` pour le
 * flux requête/réponse corrélé par `id` (voir docs/protocol.md, transport).
 */
class SidecarClient {
  constructor(child) {
    this.child = child;
    this._waiters = [];
    this._listeners = [];
    this._closed = false;
    this._closeError = null;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this._onLine(line));
    child.on("close", () => {
      this._closed = true;
      this._closeError = new Error("le sidecar s'est arrêté de façon inattendue.");
      this._rejectAll(this._closeError);
    });
  }

  onEvent(listener) {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[orch-run] ligne non-JSON du sidecar ignorée: ${trimmed}\n`);
      return;
    }
    for (const listener of this._listeners) {
      listener(evt);
    }
    for (const waiter of this._waiters) {
      if (waiter.predicate(evt)) {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(evt);
      }
    }
  }

  _rejectAll(err) {
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this._waiters = [];
  }

  waitFor(predicate, timeoutMs, label) {
    if (this._closed) {
      return Promise.reject(this._closeError);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      if (timeoutMs) {
        waiter.timer = setTimeout(() => {
          this._waiters = this._waiters.filter((w) => w !== waiter);
          reject(new Error(`timeout en attendant ${label ?? "un événement"} du sidecar.`));
        }, timeoutMs);
      }
      this._waiters.push(waiter);
    });
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Envoie une requête, résout au premier `done`/`error` corrélé par id. */
  async request(id, method, params, timeoutMs = 15000) {
    const pending = this.waitFor(
      (e) => e.id === id && (e.event === "done" || e.event === "error"),
      timeoutMs,
      `${method} (${id})`,
    );
    this.send({ id, method, params });
    const evt = await pending;
    if (evt.event === "error") {
      throw new Error(evt.data?.message || `${method} a échoué`);
    }
    return evt.data;
  }
}

function formatStep(s) {
  const modelPart = s.model ? `, model: ${s.model}` : "";
  return `  - ${s.stepId} (agent: ${s.agent}, engine: ${s.engine}${modelPart})`;
}

function formatStepList(steps) {
  return steps.map(formatStep).join("\n");
}

function printChunk(evt) {
  const data = evt.data || {};
  switch (data.kind) {
    case "run_started":
      console.log(`[orch-run] plan (${(data.steps || []).length} étape(s)) :`);
      console.log(formatStepList(data.steps || []));
      break;
    case "step_started":
      console.log(`[orch-run] -> étape "${data.stepId}" démarrée`);
      break;
    case "step_done":
      console.log(`[orch-run] OK étape "${data.stepId}" terminée — sortie: "${excerpt(data.output)}"`);
      break;
    case "step_failed":
      console.log(`[orch-run] ECHEC étape "${data.stepId}" — ${excerpt(data.message)}`);
      break;
    case "step_skipped":
      console.log(`[orch-run] SAUTEE étape "${data.stepId}" — ${excerpt(data.reason)}`);
      break;
    default:
      break; // step_chunk et autres : pas de résumé dédié (bruit token-par-token).
  }
}

function exitCodeForStatus(status) {
  if (status === "success") return 0;
  if (status === "partial") return 2;
  return 1;
}

function printFinalSummary(result) {
  console.log(`\n[orch-run] statut final : ${result.status}`);
  const steps = result.steps || {};
  for (const [stepId, info] of Object.entries(steps)) {
    const parts = [`  - ${stepId}: ${info.status}`];
    if (info.message) parts.push(`(${excerpt(info.message)})`);
    console.log(parts.join(" "));
    if (info.output) {
      console.log(`      sortie: "${excerpt(info.output)}"`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage(process.stderr);
    process.exit(1);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage(process.stdout);
    process.exit(0);
  }

  let cwd, name, inputs, saveOutput;
  try {
    ({ cwd, name, inputs, saveOutput } = parseArgs(argv));
    ({ inputs, saveOutput } = resolveTodayTemplates(inputs, saveOutput));
  } catch (err) {
    process.stderr.write(`[orch-run] argument invalide : ${err.message}\n\n`);
    printUsage();
    process.exit(1);
  }

  cwd = path.resolve(cwd);

  console.log(`[orch-run] projet: ${cwd}`);
  console.log(`[orch-run] orchestration: ${name}`);
  if (Object.keys(inputs).length > 0) {
    console.log(`[orch-run] inputs: ${JSON.stringify(inputs)}`);
  }

  const child = spawn(process.execPath, [SIDECAR_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

  const client = new SidecarClient(child);

  const RUN_ID = "orch-run-headless";
  let runStarted = false;
  let finished = false;
  let globalTimer = null;
  let signalHandling = false;

  async function abortRunAndFinish(reason) {
    if (finished) return;
    process.stderr.write(`[orch-run] ${reason}\n`);
    if (runStarted) {
      try {
        await client.request(`${RUN_ID}-abort`, "orch.abort", { targetId: RUN_ID }, 5000);
      } catch (err) {
        process.stderr.write(`[orch-run] échec de orch.abort : ${err.message}\n`);
      }
      // Laisse une courte fenêtre au run pour se terminer proprement avant de couper.
      await client
        .waitFor((e) => e.id === RUN_ID && e.event === "done", 5000, "done après abort")
        .catch(() => {});
    }
    finished = true;
  }

  function installSignalHandler(signal) {
    process.on(signal, () => {
      if (signalHandling) return;
      signalHandling = true;
      abortRunAndFinish(`${signal} reçu — annulation du run en cours…`).then(() => {
        if (globalTimer) clearTimeout(globalTimer);
        child.kill("SIGTERM");
        process.exit(1);
      });
    });
  }
  installSignalHandler("SIGTERM");
  installSignalHandler("SIGINT");

  let exitCode;

  try {
    await client.waitFor((e) => e.event === "ready", 10000, "ready");
    console.log("[orch-run] sidecar prêt.");

    const providers = await loadProvidersFile(cwd);
    if (providers) {
      const res = await client.request("providers-1", "providers.set", { providers });
      console.log(`[orch-run] providers.json poussé (${res.count ?? providers.length} fournisseur(s)).`);
    }

    // R6-A — routage : pousse la config de l'app AVANT le run (voir
    // loadRouterSetParams — config absente/illisible = débord désactivé).
    const { params: routerParams, fromConfig } = await loadRouterSetParams();
    await client.request("router-1", "router.set", routerParams);
    console.log(
      fromConfig
        ? "[orch-run] routage poussé depuis la config de l'app."
        : "[orch-run] config de l'app illisible ou absente : routage par défaut, débord DÉSACTIVÉ.",
    );

    const unsubscribe = client.onEvent((evt) => {
      if (evt.id === RUN_ID && evt.event === "chunk") {
        printChunk(evt);
      }
    });

    globalTimer = setTimeout(() => {
      abortRunAndFinish("timeout global (30 min) atteint — annulation du run.");
    }, GLOBAL_TIMEOUT_MS);
    globalTimer.unref?.();

    const donePromise = client.waitFor((e) => e.id === RUN_ID && e.event === "done", 0, "done");
    const errorPromise = client.waitFor((e) => e.id === RUN_ID && e.event === "error", 0, "error");

    runStarted = true;
    client.send({ id: RUN_ID, method: "orch.run", params: { cwd, name, inputs } });

    const evt = await Promise.race([donePromise, errorPromise]);
    unsubscribe();
    finished = true;
    if (globalTimer) clearTimeout(globalTimer);

    if (evt.event === "error") {
      process.stderr.write(
        `[orch-run] échec de résolution de l'orchestration : ${evt.data?.message ?? "erreur inconnue"}\n`,
      );
      exitCode = 1;
    } else {
      printFinalSummary(evt.data);
      if (saveOutput) {
        await saveRunOutput(saveOutput, evt.data, {
          name,
          cwd,
          dateLabel: inputs.date ?? new Date().toISOString().slice(0, 10),
        });
      }
      exitCode = exitCodeForStatus(evt.data.status);
    }
  } catch (err) {
    process.stderr.write(`[orch-run] erreur : ${err.message}\n`);
    exitCode = 1;
  } finally {
    if (globalTimer) clearTimeout(globalTimer);
    try {
      child.stdin.end();
    } catch {
      // le sidecar est peut-être déjà mort — sans conséquence ici.
    }
    child.kill("SIGTERM");
  }

  process.exitCode = exitCode;
}

main();
