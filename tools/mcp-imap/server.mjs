#!/usr/bin/env node
// Serveur MCP stdio — ménage d'une boîte IMAP (iaction, outil annexe).
//
// Voir docs/protocol.md, section « Outils annexes ». Trois outils :
// list_folders, list_messages, move_to_trash. Connexion IMAP ouverte et
// refermée à CHAQUE appel d'outil (pas d'état de connexion partagé).
// stdout est réservé au protocole MCP : tous les logs vont sur stderr.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveImapConfig } from "./src/config.mjs";
import { listFolders, listMessages, moveToTrash } from "./src/tools.mjs";

// Résolu une seule fois au démarrage (voir src/config.mjs pour la sémantique
// exacte : config incomplète => erreurs d'outil propres ; échec réel d'un
// lookup de trousseau explicite => process.exit(1) immédiat).
const config = resolveImapConfig(process.env);
if (config.ok && config.readOnly) {
  process.stderr.write("[mcp-imap] mode rapport seul actif (MCP_IMAP_READONLY=1)\n");
}
if (!config.ok) {
  process.stderr.write(
    `[mcp-imap] démarrage sans configuration IMAP valide (${config.error}) — ` +
      "les outils répondront avec une erreur explicite tant que la configuration n'est pas fournie.\n",
  );
}

const TOOLS = [
  {
    name: "list_folders",
    description: "Liste les dossiers de la boîte IMAP (chemin et usage spécial éventuel, ex. \\Trash).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_messages",
    description:
      "Liste les messages d'un dossier IMAP (par défaut INBOX), avec un aperçu texte. " +
      "Permet de filtrer par ancienneté (date de réception, INTERNALDATE) pour repérer ce qui peut être nettoyé.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Dossier IMAP à lister (défaut INBOX).",
        },
        olderThanDays: {
          type: "number",
          description: "Ne renvoyer que les messages reçus il y a plus de N jours.",
        },
        newerThanDays: {
          type: "number",
          description: "Ne renvoyer que les messages reçus il y a moins de N jours.",
        },
        limit: {
          type: "number",
          description: "Nombre maximum de messages renvoyés, les plus récents d'abord (défaut 200).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "move_to_trash",
    description:
      "Déplace des messages vers la Corbeille du dossier IMAP indiqué. " +
      "En mode rapport seul (MCP_IMAP_READONLY=1), ne fait rien et le signale.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Dossier IMAP source des messages (défaut INBOX).",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
          description: "UID IMAP des messages à déplacer vers la Corbeille.",
        },
      },
      required: ["uids"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "iaction-mcp-imap", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (!config.ok) {
    return textError(
      `serveur mcp-imap non configuré : ${config.error} ` +
        "(voir docs/protocol.md, section « Outils annexes »).",
    );
  }

  try {
    switch (name) {
      case "list_folders":
        return textResult(await listFolders(config));
      case "list_messages":
        return textResult(await listMessages(config, args));
      case "move_to_trash":
        return textResult(await moveToTrash(config, args));
      default:
        return textError(`outil inconnu : "${name}".`);
    }
  } catch (err) {
    // Contrat : une erreur IMAP (ou de saisie) ne doit JAMAIS faire crasher
    // le serveur — toujours une réponse d'outil isError lisible.
    return textError(err && err.message ? err.message : String(err));
  }
});

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[mcp-imap] serveur MCP IMAP prêt (stdio)\n");
