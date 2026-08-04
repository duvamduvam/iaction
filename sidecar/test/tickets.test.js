// Tests du backlog de tickets (tranche TK1) — JS pur, sans framework, sidecar
// piloté en JSON Lines sur stdio comme protocol.test.js / logs.test.js.
//
// Contrat vérifié : docs/protocol.md, section « Méthode TK1 — backlog de
// tickets (lecture) » — parsing d'un `tickets.md` de référence (croisement du
// tableau et des sections détaillées), tolérance à une ligne difforme,
// distinction ouverts / archivés, et réponse propre quand le fichier est
// introuvable (`disponible: false`, jamais un `error`).
//
// Le fichier lu est imposé par `IACTION_TICKETS_MD` : aucun test ne dépend
// du contenu réel de docs/tickets.md (qui bouge à chaque ticket). Un dernier
// cas vérifie tout de même la résolution PAR DÉFAUT, relative au dist du
// sidecar — c'est elle qui casserait silencieusement si l'arborescence bougeait.
//
// L'écriture du journal est isolée par un XDG_CONFIG_HOME jetable : aucun test
// ne doit toucher le ~/.config réel de la machine qui lance `npm test`.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "dist", "index.js");

function fail(message) {
  console.error(`ECHEC: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

/**
 * Backlog de référence. Volontairement imparfait — c'est un fichier écrit à la
 * main : ligne de tableau tronquée (T-003), section sans ligne de tableau
 * (T-005), ligne de tableau sans section (T-004), tableau piégé DANS un corps
 * (T-999), et un `####` qui doit rester dans le corps.
 */
const FIXTURE = `# IAction — tickets (fixture de test)

## Convention

- **ID** : \`T-001\`, incrémental, jamais réutilisé.
| ceci n'est pas | une ligne de ticket |

## Ouverts

| ID    | Type | Prio | Statut   | Titre |
|-------|------|------|----------|-------|
| T-001 | feat | P3   | ouvert   | Panneau Tickets |
| T-002 | bug  | P1   | en cours | Allowlist non appliquée |
| T-003 | tech | P2   |
| T-004 | doc  | P3   | ouvert   | Ticket sans section détaillée |

---

### T-001 — Panneau Tickets

**Type** feat · **Prio** P3 · **Statut** ouvert · **Créé** 2026-07-22

Corps du T-001, avec un tableau piégé :

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-999 | bug  | P1   | ouvert | Ne doit jamais remonter |

#### Sous-titre resté dans le corps

Fin du corps du T-001.

### T-002 — Allowlist non appliquée

**Type** bug · **Prio** P1 · **Statut** en cours · **Créé** 2026-07-31

Corps du T-002.

### T-005 — Section sans ligne de tableau

**Type** tech · **Prio** P2 · **Statut** ouvert · **Créé** 2026-07-30

Corps du T-005.

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-000 | feat | P3   | fait   | Vieux ticket clos |

### T-000 — Vieux ticket clos

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-07-01 · **Clos** 2026-07-10

Corps archivé du T-000.
`;

/** Démarre un sidecar, rend un `call(method, params)` et un `stop()`. */
async function demarrer(env) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const received = [];
  const waiters = [];
  const stderrChunks = [];

  function notifyWaiters(evt) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor(predicate, timeoutMs = 5000, label = "événement") {
    const existing = received.find(predicate);
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

  const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutRl.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar a émis une ligne non-JSON (stdout doit être réservé au protocole): ${line}`);
      return;
    }
    received.push(parsed);
    notifyWaiters(parsed);
  });
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));

  let reqSeq = 0;

  async function call(method, params, label = method) {
    reqSeq += 1;
    const id = `tk-${reqSeq}`;
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const evt = await waitFor((e) => e.id === id && (e.event === "done" || e.event === "error"), 5000, label);
    assert(evt.event === "done", `${label} doit répondre done, reçu ${JSON.stringify(evt)}`);
    return evt.data;
  }

  await waitFor((e) => e.event === "ready", 5000, "ready");

  return {
    call,
    stderrChunks,
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}

/** Retrouve un ticket par identifiant (ou `undefined`). */
function parId(tickets, id) {
  return tickets.find((t) => t.id === id);
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-tickets-"));
  const xdgConfigHome = path.join(tmp, "config");
  const fixture = path.join(tmp, "tickets.md");
  await fsp.writeFile(fixture, FIXTURE, "utf8");

  const sidecars = [];

  try {
    // -----------------------------------------------------------------------
    // 1. Parsing du backlog de référence.
    // -----------------------------------------------------------------------
    const sc = await demarrer({ XDG_CONFIG_HOME: xdgConfigHome, IACTION_TICKETS_MD: fixture });
    sidecars.push(sc);

    const data = await sc.call("tickets.list", {});
    assert(data.disponible === true, `disponible doit être true sur un fichier lisible, reçu ${JSON.stringify(data.disponible)}`);
    assert(data.chemin === fixture, `chemin attendu ${fixture}, reçu ${JSON.stringify(data.chemin)}`);
    assert(Array.isArray(data.tickets), `tickets doit être un tableau, reçu ${JSON.stringify(data.tickets)}`);

    const ids = data.tickets.map((t) => t.id);
    // Ordre du fichier : les trois lignes de tableau valides, la section
    // orpheline, puis l'archivé.
    assert(
      JSON.stringify(ids) === JSON.stringify(["T-001", "T-002", "T-004", "T-005", "T-000"]),
      `ids attendus [T-001,T-002,T-004,T-005,T-000] dans l'ordre du fichier, reçus ${JSON.stringify(ids)}`,
    );

    // -----------------------------------------------------------------------
    // 2. Tolérance : lignes difformes ignorées, jamais une erreur.
    // -----------------------------------------------------------------------
    assert(parId(data.tickets, "T-003") === undefined, "la ligne de tableau tronquée (T-003) doit être ignorée");
    assert(
      parId(data.tickets, "T-999") === undefined,
      "un tableau écrit DANS le corps d'un ticket ne doit pas produire de ticket (T-999)",
    );

    // -----------------------------------------------------------------------
    // 3. Croisement tableau ⇄ section détaillée.
    // -----------------------------------------------------------------------
    const t1 = parId(data.tickets, "T-001");
    assert(
      t1.type === "feat" && t1.prio === "P3" && t1.statut === "ouvert" && t1.titre === "Panneau Tickets",
      `T-001 mal croisé: ${JSON.stringify(t1)}`,
    );
    assert(t1.cree === "2026-07-22", `T-001 : cree attendu 2026-07-22, reçu ${JSON.stringify(t1.cree)}`);
    assert(t1.archive === false, "T-001 est dans « Ouverts », archive doit être false");
    assert(
      t1.corps.includes("**Type** feat") && t1.corps.includes("Fin du corps du T-001."),
      `T-001 : le corps doit être le Markdown de la section, tel quel — reçu ${JSON.stringify(t1.corps)}`,
    );
    assert(
      t1.corps.includes("#### Sous-titre resté dans le corps"),
      "un titre de niveau 4 doit rester DANS le corps du ticket",
    );
    assert(
      t1.corps.includes("| T-999 |"),
      "le tableau interne doit rester dans le corps (il est seulement écarté de l'index)",
    );

    // Statut en deux mots, lu depuis le tableau.
    const t2 = parId(data.tickets, "T-002");
    assert(t2.statut === "en cours", `T-002 : statut attendu « en cours », reçu ${JSON.stringify(t2.statut)}`);
    assert(t2.type === "bug" && t2.prio === "P1", `T-002 mal lu: ${JSON.stringify(t2)}`);

    // Ligne de tableau SANS section détaillée : elle remonte quand même.
    const t4 = parId(data.tickets, "T-004");
    assert(
      t4.corps === "" && t4.titre === "Ticket sans section détaillée" && t4.type === "doc",
      `T-004 (ligne sans section) mal rendu: ${JSON.stringify(t4)}`,
    );
    assert(t4.cree === "", `T-004 : cree doit rester vide sans section, reçu ${JSON.stringify(t4.cree)}`);

    // Section détaillée SANS ligne de tableau : elle remonte aussi, avec les
    // métadonnées de sa ligne d'en-tête.
    const t5 = parId(data.tickets, "T-005");
    assert(
      t5.type === "tech" && t5.prio === "P2" && t5.statut === "ouvert" && t5.cree === "2026-07-30",
      `T-005 (section sans ligne) mal rendu: ${JSON.stringify(t5)}`,
    );
    assert(
      t5.titre === "Section sans ligne de tableau",
      `T-005 : titre attendu depuis le titre de section, reçu ${JSON.stringify(t5.titre)}`,
    );
    assert(t5.archive === false, "T-005 est sous « Ouverts », archive doit être false");

    // -----------------------------------------------------------------------
    // 4. Ouverts vs Archivés.
    // -----------------------------------------------------------------------
    const t0 = parId(data.tickets, "T-000");
    assert(t0.archive === true, `T-000 est sous « Archivés », archive doit être true — reçu ${JSON.stringify(t0)}`);
    assert(t0.statut === "fait", `T-000 : statut attendu « fait », reçu ${JSON.stringify(t0.statut)}`);
    assert(
      data.tickets.filter((t) => t.archive).length === 1,
      `un seul ticket archivé attendu, reçu ${JSON.stringify(data.tickets.filter((t) => t.archive).map((t) => t.id))}`,
    );

    // -----------------------------------------------------------------------
    // 5. Fichier introuvable : réponse propre, pas une erreur de protocole.
    // -----------------------------------------------------------------------
    const absent = path.join(tmp, "nulle-part", "tickets.md");
    const scAbsent = await demarrer({ XDG_CONFIG_HOME: xdgConfigHome, IACTION_TICKETS_MD: absent });
    sidecars.push(scAbsent);
    const vide = await scAbsent.call("tickets.list", {}, "tickets.list (fichier absent)");
    assert(
      vide.disponible === false && Array.isArray(vide.tickets) && vide.tickets.length === 0,
      `fichier absent : {tickets:[], disponible:false} attendu, reçu ${JSON.stringify(vide)}`,
    );
    assert(vide.chemin === absent, `fichier absent : chemin doit dire OÙ il a été cherché, reçu ${JSON.stringify(vide.chemin)}`);

    // -----------------------------------------------------------------------
    // 6. Résolution par défaut : docs/tickets.md du dépôt, relatif au dist.
    // -----------------------------------------------------------------------
    const scDefaut = await demarrer({ XDG_CONFIG_HOME: xdgConfigHome, IACTION_TICKETS_MD: "" });
    sidecars.push(scDefaut);
    const depot = await scDefaut.call("tickets.list", {}, "tickets.list (résolution par défaut)");
    const attendu = path.resolve(__dirname, "..", "..", "docs", "tickets.md");
    assert(depot.chemin === attendu, `résolution par défaut attendue ${attendu}, reçue ${JSON.stringify(depot.chemin)}`);
    assert(depot.disponible === true, "docs/tickets.md du dépôt doit être lisible depuis les tests");
    assert(
      depot.tickets.length > 0,
      `le backlog réel doit remonter au moins un ticket, reçu ${JSON.stringify(depot.tickets)}`,
    );

    console.log("OK");
    process.exitCode = 0;
  } catch (err) {
    console.error("ECHEC du test backlog (TK1):", err.message);
    for (const sc of sidecars) {
      if (sc.stderrChunks.length > 0) {
        console.error("--- stderr du sidecar ---");
        console.error(sc.stderrChunks.join(""));
      }
    }
    process.exitCode = 1;
  } finally {
    for (const sc of sidecars) sc.stop();
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main();
