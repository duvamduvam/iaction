// Extraction best-effort d'un aperçu texte du corps d'un message.
//
// Ne lève JAMAIS : un message illisible (bodyStructure absente, partie
// texte introuvable, téléchargement en échec, encodage exotique...) donne
// simplement un snippet vide "" — jamais une erreur fatale pour le serveur.
const SNIPPET_MAX_CHARS = 300;
const DOWNLOAD_MAX_BYTES = 4000;

function findTextPart(node, wantedType) {
  if (!node) return null;
  if (typeof node.type === "string" && node.type.toLowerCase() === wantedType) {
    return node;
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      const found = findTextPart(child, wantedType);
      if (found) return found;
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/**
 * Renvoie ~300 premiers caractères du texte du message `uid` (préférence
 * text/plain, repli text/html avec balises retirées). "" si aucune partie
 * texte n'est trouvée ou en cas d'erreur quelconque.
 */
export async function extractSnippet(client, uid, bodyStructure) {
  try {
    let part = findTextPart(bodyStructure, "text/plain");
    let isHtml = false;
    if (!part) {
      part = findTextPart(bodyStructure, "text/html");
      isHtml = true;
    }
    if (!part) {
      return "";
    }
    const dl = await client.download(uid, part.part, {
      uid: true,
      maxBytes: DOWNLOAD_MAX_BYTES,
    });
    const chunks = [];
    for await (const chunk of dl.content) {
      chunks.push(chunk);
    }
    let text = Buffer.concat(chunks).toString("utf8");
    if (!part.part) {
      // Message non-multipart : download() a renvoyé le message RFC822
      // complet (en-têtes compris) faute de numéro de partie — on saute
      // les en-têtes jusqu'à la première ligne vide.
      const sepCrLf = text.indexOf("\r\n\r\n");
      const sep = sepCrLf !== -1 ? sepCrLf + 4 : text.indexOf("\n\n") + 2;
      if (sep > 1) {
        text = text.slice(sep);
      }
    }
    if (isHtml) {
      text = stripHtml(text);
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.slice(0, SNIPPET_MAX_CHARS);
  } catch {
    return "";
  }
}
