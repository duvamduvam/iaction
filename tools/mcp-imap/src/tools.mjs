// Implémentation des trois outils MCP exposés par le serveur.
import { withImapClient } from "./client.mjs";
import { extractSnippet } from "./snippet.mjs";
import { findTrashFolder } from "./trash.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatAddressList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return "";
  }
  return list
    .map((a) => {
      const address = a.address || "";
      return a.name ? `${a.name} <${address}>` : address;
    })
    .filter(Boolean)
    .join(", ");
}

/** `list_folders {}` → [{path, specialUse?}] */
export async function listFolders(config) {
  return withImapClient(config, async (client) => {
    const folders = await client.list();
    return folders.map((f) => ({ path: f.path, specialUse: f.specialUse }));
  });
}

/**
 * `list_messages {folder?, olderThanDays?, newerThanDays?, limit?}` →
 * [{uid, date, from, subject, snippet}], triés du plus récent au plus ancien.
 */
export async function listMessages(config, args = {}) {
  const folder = args.folder || "INBOX";
  const limit =
    typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 200;

  return withImapClient(config, async (client) => {
    const lock = await client.getMailboxLock(folder, {
      readOnly: true,
      description: "list_messages",
    });
    try {
      const query = {};
      const now = Date.now();
      if (typeof args.olderThanDays === "number") {
        query.before = new Date(now - args.olderThanDays * DAY_MS);
      }
      if (typeof args.newerThanDays === "number") {
        query.since = new Date(now - args.newerThanDays * DAY_MS);
      }
      if (!query.before && !query.since) {
        query.all = true;
      }

      const uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) {
        return [];
      }

      // SEARCH renvoie les UID en ordre croissant : les `limit` derniers
      // sont les messages les plus récents.
      const sortedAsc = [...uids].sort((a, b) => a - b);
      const targetUids = sortedAsc.slice(-limit);

      const results = [];
      for (const uid of targetUids) {
        try {
          const msg = await client.fetchOne(
            String(uid),
            { envelope: true, internalDate: true, bodyStructure: true },
            { uid: true },
          );
          if (!msg) continue;
          let snippet = "";
          try {
            snippet = await extractSnippet(client, uid, msg.bodyStructure);
          } catch {
            snippet = "";
          }
          results.push({
            uid,
            date: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
            from: formatAddressList(msg.envelope && msg.envelope.from),
            subject: (msg.envelope && msg.envelope.subject) || "",
            snippet,
          });
        } catch {
          // Un message illisible ne doit jamais faire échouer tout l'appel :
          // on le passe silencieusement.
        }
      }

      results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return results;
    } finally {
      lock.release();
    }
  });
}

/**
 * `move_to_trash {folder?, uids}` → {moved, trashFolder} (ou en mode
 * MCP_IMAP_READONLY=1 : {moved: 0, dryRun: true, message} sans toucher au
 * serveur).
 */
export async function moveToTrash(config, args = {}) {
  const folder = args.folder || "INBOX";
  const uids = Array.isArray(args.uids) ? args.uids : null;
  if (!uids || uids.length === 0) {
    throw new Error("le paramètre uids doit être un tableau non vide de nombres.");
  }

  if (config.readOnly) {
    return {
      moved: 0,
      dryRun: true,
      message: "mode rapport seul — aucune action",
    };
  }

  return withImapClient(config, async (client) => {
    const trashFolder = await findTrashFolder(client);
    if (!trashFolder) {
      throw new Error(
        "aucun dossier Corbeille détecté (ni specialUse \\Trash, ni nom usuel " +
          "Trash/Corbeille/INBOX.Trash) — utilisez list_folders pour inspecter la boîte.",
      );
    }
    const lock = await client.getMailboxLock(folder, { description: "move_to_trash" });
    try {
      const result = await client.messageMove(uids, trashFolder, { uid: true });
      if (!result) {
        throw new Error("le déplacement vers la corbeille a échoué (réponse serveur négative).");
      }
      const moved = result.uidMap ? result.uidMap.size : uids.length;
      return { moved, trashFolder };
    } finally {
      lock.release();
    }
  });
}
