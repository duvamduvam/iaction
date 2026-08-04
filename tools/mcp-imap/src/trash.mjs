// Détection du dossier Corbeille d'une boîte IMAP.
const TRASH_NAME_CANDIDATES = new Set([
  "trash",
  "corbeille",
  "inbox.trash",
  "inbox/trash",
]);

/**
 * Détecte le dossier Corbeille : priorité au flag standard `\Trash`
 * (specialUse IMAP), repli sur les noms usuels (Trash / Corbeille /
 * INBOX.Trash / INBOX/Trash, insensible à la casse). `null` si rien ne
 * correspond.
 */
export async function findTrashFolder(client) {
  const folders = await client.list();
  const bySpecialUse = folders.find((f) => f.specialUse === "\\Trash");
  if (bySpecialUse) {
    return bySpecialUse.path;
  }
  const byName = folders.find((f) =>
    TRASH_NAME_CANDIDATES.has(f.path.toLowerCase()),
  );
  return byName ? byName.path : null;
}
