/*
 * Échantillons témoins du protocole — la moitié SIDECAR du contrat.
 *
 * ── Le problème que ce fichier ferme ────────────────────────────────────
 * Le protocole est implémenté deux fois : émetteurs côté sidecar, parseurs
 * TOLÉRANTS côté UI (un champ absent devient null, jamais une erreur). Une
 * rupture de contrat ne casse donc rien : une fonctionnalité disparaît en
 * silence. C'est arrivé — le coût réel des tours, transmis et enregistré par
 * le sidecar, n'a jamais été affiché pendant des semaines ; et le désaccord de
 * chemins Rust/Node n'a été vu que sur le poste Windows de l'utilisateur.
 *
 * ── Le mécanisme ────────────────────────────────────────────────────────
 * fixtures/protocole/ contient des événements ENREGISTRÉS, émis par le vrai
 * sidecar (faux SDK et faux fournisseur déterministes — aucun champ volatil).
 * Deux suites les confrontent :
 *   - CE fichier rejoue les échanges contre un sidecar réel et exige l'ÉGALITÉ
 *     STRICTE avec l'événement enregistré : un champ renommé ou disparu casse
 *     ici, côté émetteur ;
 *   - ui/src/protocole.test.ts donne les mêmes fichiers aux parseurs de l'UI
 *     et exige l'extraction attendue : un parseur qui dérive casse là-bas.
 * Le fichier JSON est le point de rencontre — modifier le contrat exige de le
 * régénérer, et la revue du diff DU TÉMOIN est la revue du contrat.
 *
 * ── Régénérer (geste volontaire, à relire au diff) ──────────────────────
 *   node sidecar/test/temoins.test.js --capturer
 *
 * Lancement isolé : node sidecar/test/temoins.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fsp } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { lancer, assert, entry, fail, fakeClaudeModule, dossierTest } from "./harness.mjs";

const dossierTemoins = path.join(dossierTest, "..", "..", "fixtures", "protocole");
const capturer = process.argv.includes("--capturer");

/* ── Faux fournisseur OpenAI-compatible, réduit au strict déterministe ──── */

function creerFauxFournisseur() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      sse({ choices: [{ index: 0, delta: { content: "Bonjour témoin" }, finish_reason: null }] });
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        // Usage étendu R0 : coût réel + tokens cachés — le cas dont l'absence
        // d'affichage est passée inaperçue des semaines.
        usage: { prompt_tokens: 6, completion_tokens: 2, cost: 0.000123, prompt_tokens_details: { cached_tokens: 4 } },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ── Un sidecar piloté, comme dans protocol.test.js mais en miniature ───── */

async function avecSidecar(corps, envSupplementaire = {}) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IACTION_FAKE_CLAUDE: "1", IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule, ...envSupplementaire },
  });
  const received = [];
  const waiters = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      fail(`ligne non-JSON sur stdout : ${line}`);
      return;
    }
    received.push(evt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(evt)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(evt);
      }
    }
  });
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const waitFor = (predicate, label) => {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => reject(new Error(`timeout en attendant ${label}`)), 5000);
      waiters.push(w);
    });
  };
  try {
    await waitFor((e) => e.event === "ready", "ready");
    return await corps({ send, waitFor });
  } finally {
    child.kill();
  }
}

/* ── Confrontation stricte ──────────────────────────────────────────────── */

async function confronter(nom, evenementVivant) {
  const fichier = path.join(dossierTemoins, `${nom}.json`);
  if (capturer) {
    const temoin = JSON.parse(await fsp.readFile(fichier, "utf8"));
    temoin.evenement = evenementVivant;
    await fsp.writeFile(fichier, `${JSON.stringify(temoin, null, 2)}\n`, "utf8");
    console.log(`capturé : ${nom}`);
    return;
  }
  const temoin = JSON.parse(await fsp.readFile(fichier, "utf8"));
  // Égalité STRICTE, clés triées : un champ renommé, disparu ou ajouté casse
  // ici — c'est le but. La tolérance, c'est le rôle des parseurs UI, pas du
  // témoin.
  const stable = (v) => JSON.stringify(trier(v));
  const trier = (v) => {
    if (Array.isArray(v)) return v.map(trier);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, trier(v[k])]));
    return v;
  };
  assert(
    stable(evenementVivant) === stable(temoin.evenement),
    `${nom} : l'événement émis a dérivé du témoin.\n  émis   : ${stable(evenementVivant)}\n  témoin : ${stable(temoin.evenement)}\n  Si le changement est voulu : node sidecar/test/temoins.test.js --capturer, puis relire le diff du fichier.`,
  );
  console.log(`OK: ${nom} — l'émission colle au témoin`);
}

/* ── Les échanges canoniques ────────────────────────────────────────────── */

async function testTemoinChatSend() {
  const { server, port } = await creerFauxFournisseur();
  try {
    await avecSidecar(async ({ send, waitFor }) => {
      send({
        id: "ps-temoin",
        method: "providers.set",
        params: {
          providers: [
            { id: "temoin", label: "Témoin", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", usageAccounting: true },
          ],
        },
      });
      await waitFor((e) => e.id === "ps-temoin" && e.event === "done", "providers.set");
      send({
        id: "temoin-chat-1",
        method: "chat.send",
        params: { providerId: "temoin", model: "modele-temoin", messages: [{ role: "user", content: "Bonjour" }] },
      });
      const done = await waitFor((e) => e.id === "temoin-chat-1" && e.event !== "chunk", "done chat.send");
      await confronter("chat-send-done", done);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testTemoinClaudeStart() {
  await avecSidecar(async ({ send, waitFor }) => {
    send({ id: "temoin-claude-1", method: "claude.start", params: { cwd: "/tmp", prompt: "Bonjour" } });
    const perm = await waitFor(
      (e) => e.id === "temoin-claude-1" && e.event === "chunk" && e.data.kind === "permission_request",
      "permission_request",
    );
    send({
      id: "temoin-perm-1",
      method: "claude.permission",
      params: { targetId: "temoin-claude-1", permissionId: perm.data.permissionId, decision: "allow" },
    });
    const done = await waitFor((e) => e.id === "temoin-claude-1" && e.event !== "chunk", "done claude.start");
    await confronter("claude-start-done", done);
  });
}

/*
 * claude.comptes — foyer JETABLE (HOME/USERPROFILE) portant des identifiants du
 * second compte : le témoin ne dépend d'aucun compte réel du poste, et le
 * `~/.claude-compte2` de la machine n'est jamais lu. Le fichier ne porte que
 * l'échéance, pas de jeton.
 */
async function testTemoinClaudeComptes() {
  const foyer = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-temoin-foyer-"));
  try {
    await fsp.mkdir(path.join(foyer, ".claude-compte2"), { recursive: true });
    await fsp.writeFile(
      path.join(foyer, ".claude-compte2", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: Date.now() + 8 * 24 * 3600 * 1000 } }),
    );
    await avecSidecar(
      async ({ send, waitFor }) => {
        send({ id: "temoin-comptes-1", method: "claude.comptes", params: {} });
        const done = await waitFor((e) => e.id === "temoin-comptes-1" && e.event !== "chunk", "done claude.comptes");
        await confronter("claude-comptes-done", done);
      },
      { HOME: foyer, USERPROFILE: foyer },
    );
  } finally {
    await fsp.rm(foyer, { recursive: true, force: true });
  }
}

/*
 * claude.titreDiscussion — faux SDK dédié (fakeClaudeTitre.mjs) : aucun modèle
 * réel. La sortie « « Chansons… . » » prouve aussi le nettoyage (guillemets, point).
 */
async function testTemoinTitreDiscussion() {
  const fakeTitre = path.join(dossierTest, "fakeClaudeTitre.mjs");
  await avecSidecar(
    async ({ send, waitFor }) => {
      send({ id: "temoin-titre-1", method: "claude.titreDiscussion", params: { message: "Des chansons faciles ?", reponse: "Voici trois accords." } });
      const done = await waitFor((e) => e.id === "temoin-titre-1" && e.event !== "chunk", "done claude.titreDiscussion");
      await confronter("claude-titre-discussion-done", done);
    },
    { IACTION_FAKE_CLAUDE_MODULE: fakeTitre },
  );
}

/*
 * Chunk `model_change` (T-207) — l'agent change lui-même de modèle. Faux SDK
 * dédié (fakeClaudeModele.mjs) qui appelle le VRAI gestionnaire de l'outil
 * `changer_modele` ; le témoin est donc bien émis par le vrai sidecar.
 */
async function testTemoinModelChange() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-temoin-modele-"));
  try {
    await avecSidecar(
      async ({ send, waitFor }) => {
        send({
          id: "temoin-modele-1",
          method: "claude.start",
          params: {
            cwd,
            prompt: JSON.stringify({
              appels: [{ modele: "claude-opus-5-5", effort: "medium", raison: "Travail courant : la spec est fermée" }],
            }),
            model: "claude-fable-5-1",
            effort: "high",
            interactive: true,
          },
        });
        const chunk = await waitFor(
          (e) => e.id === "temoin-modele-1" && e.event === "chunk" && e.data.kind === "model_change",
          "chunk model_change",
        );
        await confronter("claude-model-change-chunk", chunk);
      },
      { IACTION_FAKE_CLAUDE_MODULE: path.join(dossierTest, "fakeClaudeModele.mjs"), IACTION_FAKE_CLAUDE_STUDIO: "1" },
    );
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
}

/*
 * Chunk `compaction_demandee` (T-216) — l'agent programme le compactage. Même
 * faux SDK que `model_change`, qui appelle le VRAI gestionnaire de `compacter`.
 */
async function testTemoinCompactionDemandee() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-temoin-compactage-"));
  try {
    await avecSidecar(
      async ({ send, waitFor }) => {
        send({
          id: "temoin-compactage-1",
          method: "claude.start",
          params: {
            cwd,
            prompt: JSON.stringify({ compacter: [{ raison: "Étape 2 terminée, contexte lourd" }] }),
            model: "claude-opus-5-5",
            interactive: true,
          },
        });
        const chunk = await waitFor(
          (e) => e.id === "temoin-compactage-1" && e.event === "chunk" && e.data.kind === "compaction_demandee",
          "chunk compaction_demandee",
        );
        await confronter("claude-compaction-demandee-chunk", chunk);
      },
      { IACTION_FAKE_CLAUDE_MODULE: path.join(dossierTest, "fakeClaudeModele.mjs"), IACTION_FAKE_CLAUDE_STUDIO: "1" },
    );
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
}

async function testTemoinErreur() {
  await avecSidecar(async ({ send, waitFor }) => {
    send({ id: "temoin-erreur-1", method: "methode.inconnue", params: {} });
    const err = await waitFor((e) => e.id === "temoin-erreur-1", "erreur méthode inconnue");
    await confronter("erreur-methode-inconnue", err);
  });
}

await lancer(
  capturer ? "témoins du protocole — CAPTURE" : "témoins du protocole",
  testTemoinChatSend,
  testTemoinClaudeStart,
  testTemoinClaudeComptes,
  testTemoinTitreDiscussion,
  testTemoinModelChange,
  testTemoinCompactionDemandee,
  testTemoinErreur,
);
