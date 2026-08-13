/*
 * MCP
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/mcp.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, defaultXdgConfigHome, entry, fail, fakeClaudeMcpModule, moduleCompile } from "./harness.mjs";

/**
 * Support MCP v1 de claude.start (docs/protocol.md, claude.start § MCP) :
 * lecture de <cwd>/.mcp.json. Isolé dans son propre sous-processus sidecar
 * (fakeClaudeMcp.mjs, qui rapporte ce que valait `options.mcpServers` au
 * moment de l'appel à queryFn via le champ `result` du message "result" —
 * seule façon d'observer les Options depuis ce process de test) et ses
 * propres répertoires temporaires (mkdtemp) pour cwd.
 */
async function testClaudeMcpConfig() {
  const child3 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeMcpModule,
    },
  });

  const received3 = [];
  const waiters3 = [];

  function notifyWaiters3(evt) {
    for (let i = waiters3.length - 1; i >= 0; i--) {
      const w = waiters3[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters3.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor3(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received3.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters3.indexOf(w);
        if (idx >= 0) waiters3.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters3.push(w);
    });
  }

  const stdoutRl3 = createInterface({ input: child3.stdout, crlfDelay: Infinity });
  stdoutRl3.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du troisième sidecar (fakeClaudeMcp) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received3.push(parsed);
    notifyWaiters3(parsed);
  });

  const stderrChunks3 = [];
  child3.stderr.on("data", (d) => stderrChunks3.push(d.toString()));

  function send3(obj) {
    child3.stdin.write(JSON.stringify(obj) + "\n");
  }

  let tmpDirValid = null;
  let tmpDirInvalid = null;
  let tmpDirChatOnly = null;
  let tmpDirV2 = null;

  try {
    await waitFor3((e) => e.event === "ready", 3000, "ready (troisième sidecar)");

    // (a) cwd avec .mcp.json valide -> options.mcpServers contient les serveurs.
    tmpDirValid = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-valid-"));
    const validServers = { demo: { command: "node", args: ["server.js"] } };
    await fsp.writeFile(
      path.join(tmpDirValid, ".mcp.json"),
      JSON.stringify({ mcpServers: validServers }),
      "utf8",
    );
    send3({ id: "mcp-a", method: "claude.start", params: { cwd: tmpDirValid, prompt: "mcp check a" } });
    const doneMcpA = await waitFor3(
      (e) => e.id === "mcp-a" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-a done",
    );
    assert(
      doneMcpA.event === "done",
      `mcp-a attendu 'done', reçu '${doneMcpA.event}': ${JSON.stringify(doneMcpA.data)}`,
    );
    const resultA = JSON.parse(doneMcpA.data.result);
    assert(resultA.hasMcpServers === true, `mcp-a doit passer mcpServers au SDK, reçu ${JSON.stringify(resultA)}`);
    assert(
      JSON.stringify(resultA.mcpServers) === JSON.stringify(validServers),
      `mcp-a mcpServers incorrect: ${JSON.stringify(resultA.mcpServers)}`,
    );

    // (b) .mcp.json invalide (JSON cassé) -> pas de mcpServers, pas d'erreur du tour,
    // log d'avertissement sur stderr.
    tmpDirInvalid = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-invalid-"));
    await fsp.writeFile(path.join(tmpDirInvalid, ".mcp.json"), "{ not valid json", "utf8");
    send3({ id: "mcp-b", method: "claude.start", params: { cwd: tmpDirInvalid, prompt: "mcp check b" } });
    const doneMcpB = await waitFor3(
      (e) => e.id === "mcp-b" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-b done",
    );
    assert(
      doneMcpB.event === "done",
      `mcp-b (.mcp.json invalide) doit se terminer par 'done' (jamais d'échec du tour), reçu '${doneMcpB.event}': ${JSON.stringify(doneMcpB.data)}`,
    );
    const resultB = JSON.parse(doneMcpB.data.result);
    assert(
      resultB.hasMcpServers === false,
      `mcp-b ne doit pas passer mcpServers au SDK (JSON invalide), reçu ${JSON.stringify(resultB)}`,
    );
    await new Promise((r) => setTimeout(r, 50)); // laisse le temps au chunk stderr d'arriver
    assert(
      stderrChunks3.join("").includes(".mcp.json"),
      "mcp-b (.mcp.json invalide) doit logger un avertissement sur stderr mentionnant .mcp.json",
    );

    // (c) chatOnly avec .mcp.json présent -> pas de mcpServers (chat pur = aucun outil).
    tmpDirChatOnly = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-chatonly-"));
    await fsp.writeFile(
      path.join(tmpDirChatOnly, ".mcp.json"),
      JSON.stringify({ mcpServers: validServers }),
      "utf8",
    );
    send3({
      id: "mcp-c",
      method: "claude.start",
      params: { cwd: tmpDirChatOnly, prompt: "mcp check c", chatOnly: true },
    });
    const doneMcpC = await waitFor3(
      (e) => e.id === "mcp-c" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-c done",
    );
    assert(
      doneMcpC.event === "done",
      `mcp-c attendu 'done', reçu '${doneMcpC.event}': ${JSON.stringify(doneMcpC.data)}`,
    );
    const resultC = JSON.parse(doneMcpC.data.result);
    assert(
      resultC.hasMcpServers === false,
      `mcp-c (chatOnly) ne doit jamais passer mcpServers au SDK même si .mcp.json existe, reçu ${JSON.stringify(resultC)}`,
    );
    assert(
      Array.isArray(resultC.tools) && resultC.tools.length === 0,
      `mcp-c (chatOnly) doit garder tools:[] (mode chat pur), reçu ${JSON.stringify(resultC.tools)}`,
    );

    // (d) MCP v2 — chunk `init` enrichi + instantané écrit + fiche déposée.
    // `.iaction/` présent = vrai projet IAction (sans lui, aucune écriture).
    tmpDirV2 = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-v2-"));
    await fsp.mkdir(path.join(tmpDirV2, ".iaction", "connaissances"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDirV2, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          garde: { command: "node", args: ["garde.js"] },
          eteint: { command: "node", args: ["eteint.js"] },
          sansSecret: { command: "node", args: ["x.js"], env: { TOKEN: "${SECRET:absent-du-coffre}" } },
          avecSecret: { command: "node", args: ["y.js"], env: { TOKEN: "${SECRET:mcp-test-token}" } },
        },
      }),
      "utf8",
    );
    // Interrupteur local : `eteint` ne doit jamais parvenir au SDK.
    await fsp.writeFile(
      path.join(tmpDirV2, ".iaction", "mcp.local.json"),
      JSON.stringify({ disabled: ["eteint"], allowedTools: {} }),
      "utf8",
    );
    // Coffre de secrets (XDG_CONFIG_HOME du test, voir en-tête de fichier).
    await fsp.mkdir(path.join(defaultXdgConfigHome, "net.duvam.iaction"), { recursive: true });
    await fsp.writeFile(
      path.join(defaultXdgConfigHome, "net.duvam.iaction", "mcp-secrets.json"),
      JSON.stringify({ "mcp-test-token": "valeur-secrete" }),
      "utf8",
    );

    const chunksD = [];
    send3({ id: "mcp-d", method: "claude.start", params: { cwd: tmpDirV2, prompt: "mcp check d" } });
    const doneMcpD = await waitFor3(
      (e) => e.id === "mcp-d" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-d done",
    );
    assert(doneMcpD.event === "done", `mcp-d attendu 'done', reçu '${doneMcpD.event}'`);
    for (const evt of received3) {
      if (evt.id === "mcp-d" && evt.event === "chunk") chunksD.push(evt.data);
    }
    const initD = chunksD.find((c) => c.kind === "init");
    assert(initD, "mcp-d doit émettre un chunk init");
    const namesD = (initD.mcpServers ?? []).map((s) => s.name).sort();
    assert(
      namesD.includes("garde") && namesD.includes("avecSecret"),
      `mcp-d : les serveurs actifs doivent figurer dans l'état constaté, reçu ${JSON.stringify(namesD)}`,
    );
    assert(
      !namesD.includes("eteint") && !namesD.includes("sansSecret"),
      `mcp-d : un serveur éteint ou sans secret ne doit pas apparaître dans l'état constaté, reçu ${JSON.stringify(namesD)}`,
    );
    assert(
      typeof initD.mcpToolCount === "number" && initD.mcpToolCount === namesD.length * 2,
      `mcp-d : mcpToolCount attendu ${namesD.length * 2}, reçu ${initD.mcpToolCount}`,
    );
    assert(
      initD.builtinToolCount === 1,
      `mcp-d : builtinToolCount attendu 1 (Read), reçu ${initD.builtinToolCount}`,
    );

    const resultD = JSON.parse(doneMcpD.data.result);
    const sentNames = Object.keys(resultD.mcpServers ?? {});
    assert(
      !sentNames.includes("eteint"),
      `mcp-d : un serveur désactivé dans mcp.local.json ne doit pas être transmis au SDK, reçu ${JSON.stringify(sentNames)}`,
    );
    assert(
      !sentNames.includes("sansSecret"),
      `mcp-d : un serveur dont le secret est absent du coffre ne doit pas être transmis, reçu ${JSON.stringify(sentNames)}`,
    );
    assert(
      resultD.mcpServers?.avecSecret?.env?.TOKEN === "valeur-secrete",
      `mcp-d : la référence \${SECRET:...} doit être résolue, reçu ${JSON.stringify(resultD.mcpServers?.avecSecret)}`,
    );

    // Instantané persisté + fiche des outils déposée dans connaissances/.
    const runtimeRaw = await fsp.readFile(path.join(tmpDirV2, ".iaction", "mcp.runtime.json"), "utf8");
    const runtime = JSON.parse(runtimeRaw);
    assert(
      Array.isArray(runtime.servers) && runtime.servers.some((s) => s.name === "garde" && s.tools.length === 2),
      `mcp-d : mcp.runtime.json doit décrire les outils constatés, reçu ${runtimeRaw}`,
    );
    const ficheRaw = await fsp.readFile(
      path.join(tmpDirV2, ".iaction", "connaissances", "iaction-mcp.md"),
      "utf8",
    );
    assert(
      ficheRaw.includes("mcp__garde__alpha") && ficheRaw.includes("source avant mémoire"),
      "mcp-d : la fiche iaction-mcp.md doit lister les outils réels et porter la règle « source avant mémoire »",
    );

    // (e) Allowlist : les outils non retenus partent en disallowedTools au tour
    // SUIVANT (l'allowlist s'appuie sur les outils constatés au tour précédent).
    await fsp.writeFile(
      path.join(tmpDirV2, ".iaction", "mcp.local.json"),
      JSON.stringify({ disabled: ["eteint"], allowedTools: { garde: ["alpha"] } }),
      "utf8",
    );
    send3({ id: "mcp-e", method: "claude.start", params: { cwd: tmpDirV2, prompt: "mcp check e" } });
    const doneMcpE = await waitFor3(
      (e) => e.id === "mcp-e" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-e done",
    );
    assert(doneMcpE.event === "done", `mcp-e attendu 'done', reçu '${doneMcpE.event}'`);
    const resultE = JSON.parse(doneMcpE.data.result);
    assert(
      Array.isArray(resultE.disallowedTools) && resultE.disallowedTools.includes("mcp__garde__beta"),
      `mcp-e : l'outil hors allowlist doit être retiré du contexte, reçu ${JSON.stringify(resultE.disallowedTools)}`,
    );
    assert(
      !resultE.disallowedTools.includes("mcp__garde__alpha"),
      `mcp-e : l'outil autorisé doit rester exposé, reçu ${JSON.stringify(resultE.disallowedTools)}`,
    );

    // (e bis) `mcp: false` (champ du manifeste d'agent) : aucun serveur, même
    // avec un .mcp.json valide — un agent qui refuse le MCP n'en paie pas le
    // contexte.
    send3({
      id: "mcp-e2",
      method: "claude.start",
      params: { cwd: tmpDirV2, prompt: "mcp check e2", mcp: false },
    });
    const doneMcpE2 = await waitFor3(
      (e) => e.id === "mcp-e2" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-e2 done",
    );
    assert(doneMcpE2.event === "done", `mcp-e2 attendu 'done', reçu '${doneMcpE2.event}'`);
    const resultE2 = JSON.parse(doneMcpE2.data.result);
    assert(
      resultE2.hasMcpServers === false,
      `mcp-e2 : avec mcp:false, aucun serveur ne doit être transmis, reçu ${JSON.stringify(resultE2.mcpServers)}`,
    );

    // (e ter) T-003 — allowlist `tools:` du manifeste d'agent : elle doit
    // devenir `options.tools` (base d'outils INTÉGRÉS), et non `allowedTools`
    // qui ne fait qu'auto-approuver. Les noms MCP en sont écartés : ils
    // entrent par `mcpServers` et restent disponibles.
    send3({
      id: "mcp-e3",
      method: "claude.start",
      params: {
        cwd: tmpDirV2,
        prompt: "mcp check e3",
        tools: ["Read", "Grep", "Glob", "mcp__iaction__search_knowledge"],
      },
    });
    const doneMcpE3 = await waitFor3(
      (e) => e.id === "mcp-e3" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-e3 done",
    );
    assert(doneMcpE3.event === "done", `mcp-e3 attendu 'done', reçu '${doneMcpE3.event}'`);
    const resultE3 = JSON.parse(doneMcpE3.data.result);
    assert(
      Array.isArray(resultE3.tools) && resultE3.tools.join(",") === "Read,Grep,Glob",
      `mcp-e3 : l'allowlist doit devenir options.tools sans les noms MCP, reçu ${JSON.stringify(resultE3.tools)}`,
    );

    // (e quater) Sans allowlist, `tools` reste ABSENT : le SDK garde sa
    // palette complète (comportement historique, aucune régression).
    send3({ id: "mcp-e4", method: "claude.start", params: { cwd: tmpDirV2, prompt: "mcp check e4" } });
    const doneMcpE4 = await waitFor3(
      (e) => e.id === "mcp-e4" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-e4 done",
    );
    assert(doneMcpE4.event === "done", `mcp-e4 attendu 'done', reçu '${doneMcpE4.event}'`);
    const resultE4 = JSON.parse(doneMcpE4.data.result);
    assert(
      resultE4.tools === null,
      `mcp-e4 : sans allowlist, options.tools ne doit pas être posé, reçu ${JSON.stringify(resultE4.tools)}`,
    );

    // (f) mcp.status : l'UI voit l'état constaté, les interrupteurs, les
    // secrets manquants — et JAMAIS la valeur d'un secret.
    send3({ id: "mcp-f", method: "mcp.status", params: { cwd: tmpDirV2 } });
    const doneMcpF = await waitFor3(
      (e) => e.id === "mcp-f" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.status done",
    );
    assert(doneMcpF.event === "done", `mcp.status attendu 'done', reçu '${doneMcpF.event}'`);
    const statusPayload = JSON.stringify(doneMcpF.data);
    assert(
      !statusPayload.includes("valeur-secrete"),
      "mcp.status ne doit JAMAIS renvoyer la valeur d'un secret",
    );
    const serversF = doneMcpF.data.servers ?? [];
    const eteintF = serversF.find((s) => s.name === "eteint");
    const sansSecretF = serversF.find((s) => s.name === "sansSecret");
    const gardeF = serversF.find((s) => s.name === "garde");
    assert(eteintF && eteintF.enabled === false, "mcp.status : le serveur éteint doit être rendu enabled:false");
    assert(
      sansSecretF && sansSecretF.missingSecrets.includes("absent-du-coffre"),
      `mcp.status : le secret manquant doit être signalé, reçu ${JSON.stringify(sansSecretF)}`,
    );
    assert(
      gardeF && gardeF.tools.length === 2 && gardeF.allowedTools?.length === 1,
      `mcp.status : outils constatés et allowlist attendus pour 'garde', reçu ${JSON.stringify(gardeF)}`,
    );

    // (g) mcp.setServer : l'écriture des préférences passe par le sidecar.
    send3({
      id: "mcp-g",
      method: "mcp.setServer",
      params: { cwd: tmpDirV2, name: "garde", enabled: false, allowedTools: null },
    });
    const doneMcpG = await waitFor3(
      (e) => e.id === "mcp-g" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.setServer done",
    );
    assert(doneMcpG.event === "done", `mcp.setServer attendu 'done', reçu '${doneMcpG.event}'`);
    const stateAfter = JSON.parse(
      await fsp.readFile(path.join(tmpDirV2, ".iaction", "mcp.local.json"), "utf8"),
    );
    assert(
      stateAfter.disabled.includes("garde") && stateAfter.allowedTools.garde === undefined,
      `mcp.setServer : état local attendu {disabled:[…garde], sans allowlist}, reçu ${JSON.stringify(stateAfter)}`,
    );
  } catch (err) {
    if (stderrChunks3.length > 0) {
      console.error("--- stderr du troisième sidecar (fakeClaudeMcp) ---");
      console.error(stderrChunks3.join(""));
    }
    throw err;
  } finally {
    if (child3.exitCode === null) {
      child3.kill();
    }
    if (tmpDirValid) await fsp.rm(tmpDirValid, { recursive: true, force: true }).catch(() => {});
    if (tmpDirInvalid) await fsp.rm(tmpDirInvalid, { recursive: true, force: true }).catch(() => {});
    if (tmpDirChatOnly) await fsp.rm(tmpDirChatOnly, { recursive: true, force: true }).catch(() => {});
    if (tmpDirV2) await fsp.rm(tmpDirV2, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * MCP v2 — fonctions PURES de sidecar/src/mcp.ts, testées sans sidecar ni
 * disque (import direct du module compilé) : lecture des noms d'outils,
 * instantané d'exécution, références de secrets, préférences locales, rendu
 * de la fiche déposée dans connaissances/.
 */
async function testMcpPure() {
  const mcpModuleUrl = moduleCompile("mcp.js");
  const secretsModuleUrl = moduleCompile("mcpSecrets.js");
  const {
    splitMcpToolName,
    groupToolsByServer,
    buildRuntimeSnapshot,
    normalizeMcpState,
    parseMcpConfig,
    renderMcpDoc,
    statusNeedsAuth,
  } = await import(mcpModuleUrl);
  // Coffre isolé dans son propre module (mcpSecrets.ts) : c'est la brique du
  // bas, sans dépendance vers le reste du MCP.
  const { collectSecretRefs, resolveSecretRefs } = await import(secretsModuleUrl);

  // 1. Noms d'outils : `mcp__<serveur>__<outil>`, outil pouvant contenir `__`.
  assert(
    JSON.stringify(splitMcpToolName("mcp__iaction__search_knowledge")) ===
      JSON.stringify({ server: "iaction", tool: "search_knowledge" }),
    "splitMcpToolName : décomposition serveur/outil attendue",
  );
  assert(splitMcpToolName("Read") === null, "splitMcpToolName : un outil intégré n'est pas un outil MCP");
  assert(splitMcpToolName("mcp__seul") === null, "splitMcpToolName : nom incomplet → null");

  // 2. Répartition par serveur + décompte des outils intégrés.
  const grouped = groupToolsByServer(["Read", "Bash", "mcp__a__x", "mcp__a__y", "mcp__b__z"]);
  assert(grouped.builtinToolCount === 2, `groupToolsByServer : 2 outils intégrés attendus, reçu ${grouped.builtinToolCount}`);
  assert(
    JSON.stringify(grouped.byServer.a) === JSON.stringify(["x", "y"]) &&
      JSON.stringify(grouped.byServer.b) === JSON.stringify(["z"]),
    `groupToolsByServer : répartition inattendue ${JSON.stringify(grouped.byServer)}`,
  );

  // 3. Instantané : un serveur annoncé SANS outil reste listé (c'est le
  // symptôme « branché mais inutile »), un serveur outillé non annoncé aussi.
  const snapshot = buildRuntimeSnapshot(
    [
      { name: "muet", status: "connected" },
      { name: "casse", status: "failed" },
    ],
    ["Read", "mcp__muet__none", "mcp__surprise__t"].filter((t) => t !== "mcp__muet__none"),
    "2026-08-06T10:00:00.000Z",
  );
  const muet = snapshot.servers.find((s) => s.name === "muet");
  const surprise = snapshot.servers.find((s) => s.name === "surprise");
  assert(muet && muet.tools.length === 0, "buildRuntimeSnapshot : un serveur sans outil doit rester listé");
  assert(
    surprise && surprise.tools.length === 1,
    "buildRuntimeSnapshot : un serveur exposant des outils sans figurer dans mcp_servers doit être listé",
  );
  assert(snapshot.builtinToolCount === 1, "buildRuntimeSnapshot : 1 outil intégré attendu");

  // 4. Secrets : collecte récursive, résolution, manquants signalés.
  const entry = {
    command: "node",
    args: ["s.js", "--token=${SECRET:tok}"],
    env: { A: "${SECRET:tok}", B: "${SECRET:autre}" },
  };
  assert(
    JSON.stringify(collectSecretRefs(entry)) === JSON.stringify(["autre", "tok"]),
    `collectSecretRefs : références attendues, reçu ${JSON.stringify(collectSecretRefs(entry))}`,
  );
  const resolved = resolveSecretRefs(entry, { tok: "T" });
  assert(
    resolved.value.env.A === "T" && resolved.value.args[1] === "--token=T",
    `resolveSecretRefs : substitution attendue, reçu ${JSON.stringify(resolved.value)}`,
  );
  assert(
    JSON.stringify(resolved.missing) === JSON.stringify(["autre"]),
    `resolveSecretRefs : la référence introuvable doit être signalée, reçu ${JSON.stringify(resolved.missing)}`,
  );
  assert(
    resolved.value.env.B === "${SECRET:autre}",
    "resolveSecretRefs : une référence introuvable reste littérale (l'appelant écarte le serveur)",
  );

  // 5. Préférences locales : tolérance à tout, dédoublonnage.
  const state = normalizeMcpState({ disabled: ["a", "a", 3], allowedTools: { s: ["x", "x"], bad: "non" } });
  assert(
    JSON.stringify(state.disabled) === JSON.stringify(["a"]) &&
      JSON.stringify(state.allowedTools.s) === JSON.stringify(["x"]) &&
      state.allowedTools.bad === undefined,
    `normalizeMcpState : normalisation inattendue ${JSON.stringify(state)}`,
  );
  assert(
    JSON.stringify(normalizeMcpState("n'importe quoi")) === JSON.stringify({ disabled: [], allowedTools: {} }),
    "normalizeMcpState : une valeur aberrante donne un état vide, jamais une exception",
  );

  // 6. Lecture du .mcp.json : erreur explicite plutôt que silence.
  assert(parseMcpConfig('{"mcpServers":{"a":{"command":"x"}}}').servers.a.command === "x", "parseMcpConfig : cas nominal");
  assert(parseMcpConfig("{cassé").error !== null, "parseMcpConfig : JSON invalide → error");
  assert(parseMcpConfig('{"autre":1}').error !== null, "parseMcpConfig : sans mcpServers → error");
  assert(parseMcpConfig('{"mcpServers":{"a":"non"}}').error !== null, "parseMcpConfig : entrée non-objet → error");

  // 7. Fiche projet : outils réels + règle « source avant mémoire ».
  const doc = renderMcpDoc({
    capturedAt: "2026-08-06T10:00:00.000Z",
    servers: [
      { name: "airtable", status: "connected", tools: ["list_records"] },
      { name: "muet", status: "connected", tools: [] },
    ],
    builtinToolCount: 3,
  });
  assert(doc.includes("`mcp__airtable__list_records`"), "renderMcpDoc : les outils réels doivent être listés");
  assert(doc.includes("source avant mémoire"), "renderMcpDoc : la règle doit être écrite noir sur blanc");
  assert(doc.includes("muet"), "renderMcpDoc : un serveur sans outil doit être signalé comme tel");

  // 8. Détection d'un statut réclamant une authentification.
  assert(statusNeedsAuth("needs_auth") && statusNeedsAuth("UNAUTHORIZED"), "statusNeedsAuth : statuts d'auth");
  assert(!statusNeedsAuth("connected"), "statusNeedsAuth : un serveur connecté ne réclame rien");
}

await lancer(
  "MCP",
  testClaudeMcpConfig,
  testMcpPure,
);
