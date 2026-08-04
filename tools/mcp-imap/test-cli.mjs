#!/usr/bin/env node
// Harnais de test minimal pour le serveur MCP IMAP.
//
// Sans credentials dans l'environnement (IMAP_HOST/IMAP_USER/IMAP_PASSWORD) :
// - vérifie le handshake MCP (initialize + tools/list) ;
// - vérifie que list_messages sans configuration renvoie une erreur d'outil
//   propre (isError), jamais un crash du serveur.
//
// Avec ces trois variables posées (test réel, jamais lancé automatiquement
// sans credentials existants) : appelle aussi list_folders pour de vrai.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "server.mjs");

function fail(message) {
  console.error(`ECHEC: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function main() {
  const hasRealCreds = Boolean(
    process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD,
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    // N'hérite QUE de l'environnement courant : si aucune variable IMAP_*
    // n'est déjà posée par l'appelant, le serveur démarre sans config.
    env: { ...process.env },
    stderr: "pipe",
  });

  const client = new Client({ name: "mcp-imap-test-cli", version: "0.1.0" });

  let stderrOutput = "";
  transport.stderr?.on("data", (chunk) => {
    stderrOutput += chunk.toString("utf8");
  });

  console.log(`[test-cli] connexion au serveur (${hasRealCreds ? "avec" : "sans"} credentials)...`);
  await client.connect(transport);
  console.log("[test-cli] handshake initialize OK.");

  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name).sort();
  console.log(`[test-cli] tools/list OK : ${toolNames.join(", ")}`);
  assert(
    JSON.stringify(toolNames) === JSON.stringify(["list_folders", "list_messages", "move_to_trash"]),
    `outils inattendus : ${toolNames.join(", ")}`,
  );

  if (hasRealCreds) {
    console.log("[test-cli] credentials détectées : appel réel de list_folders...");
    const result = await client.callTool({ name: "list_folders", arguments: {} });
    assert(!result.isError, `list_folders a échoué : ${JSON.stringify(result.content)}`);
    console.log("[test-cli] list_folders OK :", result.content[0]?.text?.slice(0, 500));
  } else {
    console.log("[test-cli] pas de credentials : vérification de l'erreur propre sur list_messages...");
    const result = await client.callTool({ name: "list_messages", arguments: {} });
    assert(result.isError === true, "list_messages sans config aurait dû renvoyer isError:true");
    const message = result.content?.[0]?.text || "";
    assert(message.length > 0, "le message d'erreur de list_messages ne doit pas être vide");
    console.log(`[test-cli] list_messages a bien renvoyé une erreur propre : "${message}"`);
  }

  await client.close();
  console.log("[test-cli] stderr du serveur (extrait) :", stderrOutput.trim().split("\n").slice(0, 5).join(" | "));

  if (process.exitCode) {
    console.error("[test-cli] RESULTAT : ECHEC");
  } else {
    console.log("[test-cli] RESULTAT : OK");
  }
}

main().catch((err) => {
  console.error("ECHEC (exception non gérée):", err);
  process.exitCode = 1;
});
