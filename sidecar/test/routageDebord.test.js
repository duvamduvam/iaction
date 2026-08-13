/*
 * routage — débord d'abonnement et plafond
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/routageDebord.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail, fakeClaudeModule } from "./harness.mjs";

/**
 * R3 — débord, plafond et agrégat routage (docs/spec-r3-debord.md §4).
 * Sous-processus sidecar isolé avec son propre XDG_CONFIG_HOME : le test
 * forge claude-windows.jsonl (instantané de fenêtres) et events.jsonl
 * (dépense de débord), que le sidecar relit à chaque appel (aucun cache).
 */
async function testR3Debord() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-r3-xdg-"));
  const usageDir = path.join(xdgDir, "net.duvam.iaction", "usage");
  await fsp.mkdir(usageDir, { recursive: true });
  const windowsFile = path.join(usageDir, "claude-windows.jsonl");
  const eventsFile = path.join(usageDir, "events.jsonl");
  // S2 — usage.stats lit aussi l'état applicatif (project-conversations.json,
  // sous XDG_DATA_HOME) : il DOIT être isolé, sinon le test lirait l'état réel
  // du poste de développement.
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-r3-data-"));
  const stateDir = path.join(dataDir, "net.duvam.iaction", "state");
  await fsp.mkdir(stateDir, { recursive: true });

  const child7 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
      XDG_CONFIG_HOME: xdgDir,
      XDG_DATA_HOME: dataDir,
    },
  });

  const received7 = [];
  const waiters7 = [];

  function notifyWaiters7(evt) {
    for (let i = waiters7.length - 1; i >= 0; i--) {
      const w = waiters7[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters7.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor7(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received7.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters7.indexOf(w);
        if (idx >= 0) waiters7.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters7.push(w);
    });
  }

  const stdoutRl7 = createInterface({ input: child7.stdout, crlfDelay: Infinity });
  stdoutRl7.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du septième sidecar (R3 débord) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received7.push(parsed);
    notifyWaiters7(parsed);
  });

  const stderrChunks7 = [];
  child7.stderr.on("data", (d) => stderrChunks7.push(d.toString()));

  function send7(obj) {
    child7.stdin.write(JSON.stringify(obj) + "\n");
  }

  try {
    await waitFor7((e) => e.event === "ready", 3000, "ready (septième sidecar)");

  // Table explicite : ces scénarios raisonnent sur « trivial local / étage
  // claude » — on ne dépend pas des défauts produit (choix utilisateur mouvants).
  const R3_TABLE = {
    trivial: { engine: "neutral", providerId: "ollama", model: "qwen3.5:4b" },
    simple: { engine: "claude", model: "claude-haiku-4-5" },
    moyen: { engine: "claude", model: "claude-sonnet-5" },
    complexe: { engine: "claude", model: "claude-fable-5" },
  };
    send7({ id: "rs-r3-init", method: "router.set", params: { table: R3_TABLE } });
    await waitFor7((e) => e.id === "rs-r3-init" && e.event === "done", 3000, "router.set rs-r3-init");

    // Spec R3 §4.3 : PAS d'instantané de fenêtres -> routage R1 inchangé,
    // aucun champ debord dans le done.
    send7({ id: "rd1", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd1 = await waitFor7((e) => e.id === "rd1" && e.event === "done", 3000, "router.route rd1");
    assert(
      doneRd1.data.tier === "simple" &&
        JSON.stringify(doneRd1.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd1 : sans instantané, cible du tier simple attendue, reçu ${JSON.stringify(doneRd1.data)}`,
    );
    assert(
      doneRd1.data.debord === undefined,
      `rd1 : champ debord absent attendu (pas d'instantané), reçu ${JSON.stringify(doneRd1.data.debord)}`,
    );

    // R6-A — fraîcheur : un instantané VIEUX de 2 h (> DEBORD_SNAPSHOT_MAX_AGE_MS,
    // 30 min) est ignoré même saturé à 95 % -> comportement « pas d'instantané »
    // (pas de débord).
    const staleTs = new Date(Date.now() - 2 * 3600_000).toISOString();
    await fsp.writeFile(
      windowsFile,
      JSON.stringify({ ts: staleTs, windows: { five_hour: { utilization: 95, resetsAt: staleTs } } }) + "\n",
      "utf8",
    );
    send7({ id: "rd1b", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd1b = await waitFor7((e) => e.id === "rd1b" && e.event === "done", 3000, "router.route rd1b");
    assert(
      doneRd1b.data.debord === undefined &&
        JSON.stringify(doneRd1b.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd1b : instantané périmé (2 h) -> pas de débord attendu, reçu ${JSON.stringify(doneRd1b.data)}`,
    );

    // Spec R3 §4.1 : fenêtre 5 h forgée à 95 % (>= seuil 90 par défaut) ->
    // débord actif vers la cible par défaut (openrouter · deepseek). Le
    // DERNIER instantané prime (le premier, à 10 %, doit être ignoré).
    const oldTs = new Date(Date.now() - 3600_000).toISOString();
    await fsp.writeFile(
      windowsFile,
      JSON.stringify({ ts: oldTs, windows: { five_hour: { utilization: 10, resetsAt: oldTs } } }) +
        "\n" +
        JSON.stringify({
          ts: new Date().toISOString(),
          windows: { five_hour: { utilization: 95, resetsAt: oldTs }, seven_day: { utilization: 40, resetsAt: oldTs } },
        }) +
        "\n",
      "utf8",
    );
    send7({ id: "rd2", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd2 = await waitFor7((e) => e.id === "rd2" && e.event === "done", 3000, "router.route rd2");
    assert(
      JSON.stringify(doneRd2.data.debord) === JSON.stringify({ active: true, fiveHourPct: 95, sevenDayPct: 40 }),
      `rd2 : debord actif attendu, reçu ${JSON.stringify(doneRd2.data.debord)}`,
    );
    // T-005 — la raison nomme la fenêtre déclencheuse : la 5 h, pas la 7 jours (40 % < seuil).
    assert(
      doneRd2.data.reasons.some((r) => r.includes("5 h à 95 %")) &&
        !doneRd2.data.reasons.some((r) => r.includes("7 jours")),
      `rd2 : raison « 5 h à 95 % » seule attendue, reçu ${JSON.stringify(doneRd2.data.reasons)}`,
    );
    assert(
      JSON.stringify(doneRd2.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat" }),
      `rd2 : cible de débord par défaut attendue, reçu ${JSON.stringify(doneRd2.data.target)}`,
    );
    assert(
      Array.isArray(doneRd2.data.reasons) && doneRd2.data.reasons.some((r) => r.includes("débord")),
      `rd2 : raison de débord attendue, reçu ${JSON.stringify(doneRd2.data.reasons)}`,
    );

    // Une cible NEUTRE (tier trivial par défaut) ne déborde jamais.
    send7({ id: "rd2b", method: "router.route", params: { text: "Salut, ça va ?" } });
    const doneRd2b = await waitFor7((e) => e.id === "rd2b" && e.event === "done", 3000, "router.route rd2b");
    assert(
      doneRd2b.data.tier === "trivial" && doneRd2b.data.debord === undefined,
      `rd2b : une cible neutre ne doit pas déborder, reçu ${JSON.stringify(doneRd2b.data)}`,
    );

    // T-005 (constat du 2026-08-08) : fenêtre 5 h SOUS le seuil (50 %) mais
    // fenêtre 7 JOURS saturée (100 %) -> débord actif quand même. C'était le
    // trou : la semaine morte laissait partir les tours vers l'abonnement.
    await fsp.writeFile(
      windowsFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        windows: { five_hour: { utilization: 50, resetsAt: oldTs }, seven_day: { utilization: 100, resetsAt: oldTs } },
      }) + "\n",
      "utf8",
    );
    send7({ id: "rd2c", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd2c = await waitFor7((e) => e.id === "rd2c" && e.event === "done", 3000, "router.route rd2c");
    assert(
      JSON.stringify(doneRd2c.data.debord) === JSON.stringify({ active: true, fiveHourPct: 50, sevenDayPct: 100 }),
      `rd2c : débord sur fenêtre 7 jours attendu, reçu ${JSON.stringify(doneRd2c.data.debord)}`,
    );
    assert(
      doneRd2c.data.reasons.some((r) => r.includes("7 jours à 100 %")) &&
        !doneRd2c.data.reasons.some((r) => r.includes("5 h à")),
      `rd2c : raison « 7 jours à 100 % » seule attendue, reçu ${JSON.stringify(doneRd2c.data.reasons)}`,
    );
    assert(
      JSON.stringify(doneRd2c.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat" }),
      `rd2c : cible de débord attendue, reçu ${JSON.stringify(doneRd2c.data.target)}`,
    );

    // Restaure l'instantané des scénarios suivants (5 h saturée à 95 %).
    await fsp.writeFile(
      windowsFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        windows: { five_hour: { utilization: 95, resetsAt: oldTs }, seven_day: { utilization: 40, resetsAt: oldTs } },
      }) + "\n",
      "utf8",
    );

    // router.set : cible de débord personnalisée (mock/debord-model).
    send7({
      id: "rs-r3",
      method: "router.set",
      params: {
        table: R3_TABLE,
        debord: {
          target: { engine: "neutral", providerId: "mock", model: "debord-model" },
          seuilPct: 90,
          plafondUsdMois: 10,
        },
      },
    });
    await waitFor7((e) => e.id === "rs-r3" && e.event === "done", 3000, "router.set rs-r3");
    send7({ id: "rd3", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd3 = await waitFor7((e) => e.id === "rd3" && e.event === "done", 3000, "router.route rd3");
    assert(
      JSON.stringify(doneRd3.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "mock", model: "debord-model" }),
      `rd3 : cible de débord poussée attendue, reçu ${JSON.stringify(doneRd3.data.target)}`,
    );

    // R3 — tier IMPOSÉ (params.tier) : aucune classification, résolution
    // cible + débord seule (utilisé par l'UI sur les tours à affinité).
    send7({ id: "rd4", method: "router.route", params: { text: "Salut", tier: "complexe" } });
    const doneRd4 = await waitFor7((e) => e.id === "rd4" && e.event === "done", 3000, "router.route rd4");
    assert(
      doneRd4.data.tier === "complexe" &&
        doneRd4.data.score === 0 &&
        doneRd4.data.reasons.includes("tier imposé par l'appelant") &&
        doneRd4.data.debord &&
        doneRd4.data.debord.active === true,
      `rd4 : tier imposé + débord actif attendus, reçu ${JSON.stringify(doneRd4.data)}`,
    );

    // Spec R3 §4.2 : plafond atteint (événements forgés routeDebord+costUsd,
    // 6 + 5 = 11 >= 10 ce mois-ci) -> repli sur la cible du tier trivial,
    // debord {active:false, blocked:true}.
    const nowIso = new Date().toISOString();
    await fsp.writeFile(
      eventsFile,
      [
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 6 }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 5 }),
        // Payant choisi MANUELLEMENT (sans routeDebord) : n'entre jamais dans le plafond.
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "gpt-couteux", status: "done", costUsd: 100 }),
      ].join("\n") + "\n",
      "utf8",
    );
    send7({ id: "rd5", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd5 = await waitFor7((e) => e.id === "rd5" && e.event === "done", 3000, "router.route rd5");
    assert(
      JSON.stringify(doneRd5.data.debord) === JSON.stringify({ active: false, blocked: true, fiveHourPct: 95, sevenDayPct: 40 }),
      `rd5 : debord bloqué attendu (plafond atteint), reçu ${JSON.stringify(doneRd5.data.debord)}`,
    );
    assert(
      JSON.stringify(doneRd5.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "ollama", model: "qwen3.5:4b" }),
      `rd5 : repli sur la cible du tier trivial attendu, reçu ${JSON.stringify(doneRd5.data.target)}`,
    );

    // R6-A — garde du repli « plafond atteint » : si le tier trivial n'est PAS
    // un moteur neutre sur provider LOCAL (ici openrouter, payant), le repli
    // ne doit router ni vers du payant ni vers l'abo « au nom du repli
    // local » : la cible claude d'origine est conservée.
    send7({
      id: "rs-r6-guard",
      method: "router.set",
      params: {
        table: { ...R3_TABLE, trivial: { engine: "neutral", providerId: "openrouter", model: "pas-local" } },
        debord: {
          target: { engine: "neutral", providerId: "mock", model: "debord-model" },
          seuilPct: 90,
          plafondUsdMois: 10,
        },
      },
    });
    await waitFor7((e) => e.id === "rs-r6-guard" && e.event === "done", 3000, "router.set rs-r6-guard");
    send7({ id: "rd5b", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd5b = await waitFor7((e) => e.id === "rd5b" && e.event === "done", 3000, "router.route rd5b");
    assert(
      JSON.stringify(doneRd5b.data.debord) === JSON.stringify({ active: false, blocked: true, fiveHourPct: 95, sevenDayPct: 40 }),
      `rd5b : debord bloqué attendu (plafond atteint), reçu ${JSON.stringify(doneRd5b.data.debord)}`,
    );
    assert(
      JSON.stringify(doneRd5b.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd5b : cible claude d'origine CONSERVÉE attendue (trivial non local), reçu ${JSON.stringify(doneRd5b.data.target)}`,
    );
    assert(
      Array.isArray(doneRd5b.data.reasons) &&
        doneRd5b.data.reasons.some((r) => r.includes("cible abonnement conservée")),
      `rd5b : raison « cible abonnement conservée » attendue, reçu ${JSON.stringify(doneRd5b.data.reasons)}`,
    );

    // plafondUsdMois: null = SANS plafond -> débord actif malgré la dépense.
    send7({
      id: "rs-r3b",
      method: "router.set",
      params: {
        table: R3_TABLE,
        debord: {
          target: { engine: "neutral", providerId: "mock", model: "debord-model" },
          seuilPct: 90,
          plafondUsdMois: null,
        },
      },
    });
    await waitFor7((e) => e.id === "rs-r3b" && e.event === "done", 3000, "router.set rs-r3b");
    send7({ id: "rd6", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd6 = await waitFor7((e) => e.id === "rd6" && e.event === "done", 3000, "router.route rd6");
    assert(
      doneRd6.data.debord && doneRd6.data.debord.active === true,
      `rd6 : sans plafond, débord actif attendu malgré la dépense, reçu ${JSON.stringify(doneRd6.data.debord)}`,
    );

    // R6-A — `debord: null` = débord DÉSACTIVÉ : jamais de bascule payante
    // automatique, même fenêtre saturée (distinct de « champ absent » =
    // défauts, couvert par rd2). C'est l'état poussé par le runner headless
    // quand la config de l'app est illisible.
    send7({ id: "rs-r6-off", method: "router.set", params: { table: R3_TABLE, debord: null } });
    await waitFor7((e) => e.id === "rs-r6-off" && e.event === "done", 3000, "router.set rs-r6-off");
    send7({ id: "rd7", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd7 = await waitFor7((e) => e.id === "rd7" && e.event === "done", 3000, "router.route rd7");
    assert(
      doneRd7.data.debord === undefined &&
        JSON.stringify(doneRd7.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd7 : debord:null -> aucun débord attendu (cible du tier conservée), reçu ${JSON.stringify(doneRd7.data)}`,
    );

    // Spec R3 §4.4 : agrégat `routage` de usage.stats sur événements forgés.
    // 5 tours dans la période : 2 claude (routeTier simple), 1 ollama
    // (trivial), 1 débord openrouter (simple, 0.5 $), 1 manuel openrouter
    // sans routeTier ; plus 1 vieux débord (60 jours : hors période ET hors
    // mois calendaire courant, quel que soit le jour du test).
    const oldMonthIso = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    await fsp.writeFile(
      eventsFile,
      [
        JSON.stringify({ ts: nowIso, engine: "claude", providerId: null, model: "claude-haiku-4-5", status: "done", routeTier: "simple" }),
        JSON.stringify({ ts: nowIso, engine: "claude", providerId: null, model: "claude-haiku-4-5", status: "done", routeTier: "simple" }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "ollama", model: "qwen3.5:4b", status: "done", routeTier: "trivial" }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 0.5 }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "gpt-couteux", status: "done" }),
        JSON.stringify({ ts: oldMonthIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 99 }),
      ].join("\n") + "\n",
      "utf8",
    );
    send7({ id: "us-r3", method: "usage.stats", params: {} });
    const doneUsR3 = await waitFor7((e) => e.id === "us-r3" && e.event === "done", 3000, "usage.stats us-r3");
    const routage = doneUsR3.data.routage;
    assert(routage, `us-r3 : champ routage attendu, reçu ${JSON.stringify(doneUsR3.data)}`);
    assert(
      routage.toursAuto === 4,
      `us-r3 : toursAuto attendu 4, reçu ${JSON.stringify(routage.toursAuto)}`,
    );
    assert(
      JSON.stringify(routage.parTier) === JSON.stringify({ simple: { tours: 3 }, trivial: { tours: 1 } }),
      `us-r3 : parTier incorrect, reçu ${JSON.stringify(routage.parTier)}`,
    );
    // 3 tours à coût nul (2 claude + 1 ollama) sur 5 -> 60 %.
    assert(
      routage.partCoutNulPct === 60,
      `us-r3 : partCoutNulPct attendu 60, reçu ${JSON.stringify(routage.partCoutNulPct)}`,
    );
    assert(
      JSON.stringify(routage.mixAbo) === JSON.stringify([{ model: "claude-haiku-4-5", tours: 2 }]),
      `us-r3 : mixAbo incorrect, reçu ${JSON.stringify(routage.mixAbo)}`,
    );
    // Seul le débord du MOIS CALENDAIRE COURANT compte (0.5, pas 99.5).
    assert(
      routage.debordMoisUsd === 0.5,
      `us-r3 : debordMoisUsd attendu 0.5, reçu ${JSON.stringify(routage.debordMoisUsd)}`,
    );
    // S3/T-035 — dépense RÉELLE de la période : tout le payant, pas seulement
    // le débord automatique. Ici seul le tour débordé a remonté un coût (0.5) ;
    // le tour openrouter choisi À LA MAIN n'en remonte aucun, et c'est
    // précisément ce que `coutInconnuTours` doit dire — sans quoi 0.50 $
    // passerait pour un total alors que c'est un minorant.
    assert(
      routage.coutPeriodeUsd === 0.5,
      `us-r3 : coutPeriodeUsd attendu 0.5, reçu ${JSON.stringify(routage.coutPeriodeUsd)}`,
    );
    assert(
      routage.coutInconnuTours === 1,
      `us-r3 : coutInconnuTours attendu 1 (openrouter manuel sans costUsd), reçu ${JSON.stringify(routage.coutInconnuTours)}`,
    );

    // R6-A — rotation : un événement de débord du mois courant BASCULÉ dans
    // events.jsonl.1 (rotation 20 Mo) compte AUSSI dans le plafond/l'agrégat
    // mensuel (0.5 + 2 = 2.5).
    await fsp.writeFile(
      `${eventsFile}.1`,
      JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 2 }) + "\n",
      "utf8",
    );
    send7({ id: "us-r6rot", method: "usage.stats", params: {} });
    const doneUsR6rot = await waitFor7((e) => e.id === "us-r6rot" && e.event === "done", 3000, "usage.stats us-r6rot");
    assert(
      doneUsR6rot.data.routage.debordMoisUsd === 2.5,
      `us-r6rot : debordMoisUsd attendu 2.5 (events.jsonl.1 inclus), reçu ${JSON.stringify(doneUsR6rot.data.routage.debordMoisUsd)}`,
    );

    // S2 — agrégat `parProjet` de usage.stats (encart « Usage par projet ») :
    // attribution par projectId, par projectPath (projet déclaré dans
    // config.json), pseudo-projet Chat, répertoire inconnu et résidu.
    await fsp.writeFile(
      path.join(xdgDir, "net.duvam.iaction", "config.json"),
      JSON.stringify({
        projects: [
          { id: "orgai", name: "OrgAI", path: "/tmp/orgai" },
          { id: "rdpl", name: "RDPL", path: "/tmp/rdpl/" },
        ],
      }),
      "utf8",
    );
    await fsp.writeFile(
      eventsFile,
      [
        // OrgAI : 200 tokens à la main + 100 tokens en orchestration (part autonome).
        JSON.stringify({ ts: nowIso, engine: "claude", status: "done", source: "projet", projectId: "orgai", promptTokens: 100, completionTokens: 100 }),
        JSON.stringify({ ts: nowIso, engine: "claude", status: "done", orchRunId: "run-1", orchStepId: "s1", projectPath: "/tmp/orgai", promptTokens: 50, completionTokens: 50 }),
        // RDPL : rattaché par le répertoire du run (chemin déclaré avec un / final).
        JSON.stringify({ ts: nowIso, engine: "claude", status: "done", orchRunId: "run-2", orchStepId: "s1", projectPath: "/tmp/rdpl", promptTokens: 200, completionTokens: 100 }),
        // Chat : pseudo-projet dérivé de source.
        JSON.stringify({ ts: nowIso, engine: "neutral", status: "done", source: "chat", conversationId: "c-1", promptTokens: 300, completionTokens: 100 }),
        // Répertoire non déclaré : conservé sous `chemin:<dir>`, pas noyé dans le résidu.
        JSON.stringify({ ts: nowIso, engine: "claude", status: "done", orchRunId: "run-3", orchStepId: "s1", projectPath: "/tmp/pas-declare", promptTokens: 0, completionTokens: 0 }),
        // Tour d'avant S2 : rattrapé par son conversationId (state applicatif).
        JSON.stringify({ ts: nowIso, engine: "claude", status: "done", source: "projet", conversationId: "conv-rdpl", promptTokens: 0, completionTokens: 0 }),
        // Tour d'avant S2 dont la conversation n'existe plus : reste au résidu.
        JSON.stringify({ ts: nowIso, engine: "neutral", status: "done", source: "projet", conversationId: "conv-supprimee", promptTokens: 0, completionTokens: 0 }),
      ].join("\n") + "\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(stateDir, "project-conversations.json"),
      JSON.stringify({ rdpl: { sessions: [{ id: "conv-rdpl" }, { id: "conv-rdpl-2" }] } }),
      "utf8",
    );
    send7({ id: "us-s2", method: "usage.stats", params: {} });
    const doneUsS2 = await waitFor7((e) => e.id === "us-s2" && e.event === "done", 3000, "usage.stats us-s2");
    const parProjet = doneUsS2.data.parProjet;
    assert(Array.isArray(parProjet), `us-s2 : parProjet attendu, reçu ${JSON.stringify(doneUsS2.data)}`);
    const parts = parProjet.map((p) => `${p.projectId}:${p.name}:${p.partTokensPct}`);
    // L'id d'un projet NON déclaré est `chemin:<répertoire résolu>` (voir
    // `resolveProjet`/`normalizeDir`, sidecar/src/usageStats.ts) : on le calcule
    // avec le même `path.resolve` que le code plutôt que de l'écrire en dur.
    // Sous Windows, `/tmp/pas-declare` se résout en `D:\tmp\pas-declare` — un
    // littéral POSIX faisait tomber ce test sur le runner Windows alors que le
    // comportement était correct.
    const cheminNonDeclare = `chemin:${path.resolve("/tmp/pas-declare")}`;
    assert(
      JSON.stringify(parts) ===
        JSON.stringify([
          "chat:Chat:40",
          "orgai:OrgAI:30",
          "rdpl:RDPL:30",
          `${cheminNonDeclare}:pas-declare:0`,
          "null:(non attribué):0",
        ]),
      `us-s2 : répartition par projet incorrecte, reçue ${JSON.stringify(parts)}`,
    );
    const orgai = parProjet.find((p) => p.projectId === "orgai");
    assert(
      orgai.tours === 2 && orgai.totalTokens === 300 && orgai.autonomeTours === 1 && orgai.autonomeTokens === 100 && orgai.autonomePct === 33,
      `us-s2 : part autonome d'OrgAI incorrecte, reçue ${JSON.stringify(orgai)}`,
    );
    const chat = parProjet.find((p) => p.projectId === "chat");
    assert(
      chat.autonomeTours === 0 && chat.autonomePct === 0,
      `us-s2 : le Chat ne doit avoir aucune part autonome, reçu ${JSON.stringify(chat)}`,
    );
    // Rattrapage : le tour d'avant S2 rejoint RDPL par son conversationId ;
    // celui dont la conversation a disparu reste au résidu.
    const rdpl = parProjet.find((p) => p.projectId === "rdpl");
    const residu = parProjet.find((p) => p.projectId === null);
    assert(
      rdpl.tours === 2 && residu.tours === 1,
      `us-s2 : rattrapage par conversationId incorrect (RDPL ${JSON.stringify(rdpl)}, résidu ${JSON.stringify(residu)})`,
    );
  } catch (err) {
    if (stderrChunks7.length > 0) {
      console.error("--- stderr du septième sidecar (R3 débord) ---");
      console.error(stderrChunks7.join(""));
    }
    throw err;
  } finally {
    if (child7.exitCode === null) {
      child7.kill();
    }
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "routage — débord d'abonnement et plafond",
  testR3Debord,
);
