/*
 * Pièces jointes — construction du prompt à blocs (voir docs/protocol.md,
 * section Pièces jointes, § « Moteur Claude »). Uniquement emprunté quand
 * params.attachments contient au moins une pièce ; sans pièces jointes, le
 * prompt reste une simple chaîne (chemin inchangé, zéro régression).
 *
 * Sorti de claude.ts (cliquet de taille) : ce bloc — la mise en forme d'UN
 * message utilisateur SDK, et le prompt en entrée streamée qui le porte —
 * ne dépend que du type `Attachment` et des helpers d'attachments.ts ; il
 * n'a aucun couplage avec le reste du moteur (émetteur, état de tour,
 * journal…), qui se contente d'appeler `createTurnPrompt` une fois par tour.
 */
import {
  formatTextAttachmentPrefix,
  isImageAttachment,
  isTextAttachment,
  type Attachment,
} from "./attachments.js";

/**
 * Un unique message utilisateur SDK (forme `SDKUserMessage` minimale : les
 * champs optionnels du SDK — uuid, session_id, etc. — sont omis, le SDK ne
 * les exige pas) porté par un flux asynchrone d'un seul élément, comme l'exige
 * la signature `query({prompt: string | AsyncIterable<SDKUserMessage>})`.
 */
function buildUserMessage(promptText: string, attachments: Attachment[]): Record<string, unknown> {
  const textPrefixes = attachments
    .filter(isTextAttachment)
    .map((doc) => formatTextAttachmentPrefix(doc.name, doc.content));
  const text = [...textPrefixes, promptText].filter((part) => part.length > 0).join("\n\n");

  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const image of attachments.filter(isImageAttachment)) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    });
  }

  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * Prompt d'un tour en ENTRÉE STREAMÉE : yield le message utilisateur, puis
 * reste suspendu jusqu'à `close()` — en livrant au passage les messages
 * poussés par `push()` (claude.push, voir plus bas).
 *
 * Pourquoi ne pas passer une simple chaîne : avec un prompt-chaîne (ou un
 * générateur d'un seul élément), le SDK ferme l'entrée aussitôt et le CLI
 * s'ARRÊTE de lui-même après le `result` — emportant ses tâches de fond
 * (`run_in_background`), tuées à mi-course. Vécu le 2026-07-31 : un
 * `make docs-build` lancé en fond meurt 5 s après la fin du tour, et le tour
 * suivant reçoit ses `task-notification` « orphelines ». Garder l'entrée
 * ouverte laisse le process vivre : les tâches poursuivent, leurs rapports
 * réveillent l'agent (nouveau tour → nouveau `result`), et c'est le sidecar
 * qui décide de la fin (plafond BACKGROUND_WAIT_TIMEOUT_MS ou claude.release).
 * `close()` est donc OBLIGATOIRE en fin de tour, sinon le process CLI fuit.
 *
 * S3 — `push()` glisse un message utilisateur SUPPLÉMENTAIRE dans cette même
 * entrée pendant que le tour tourne (« demande en cours de route », méthode
 * `claude.push`). Le CLI l'injecte au prochain retour d'outil, DANS le tour
 * courant — vérifié sur le vrai moteur : un message poussé à T+6 s a été pris
 * en compte à T+18 s (fin du premier Bash), sans `result` intermédiaire. Même
 * comportement que Claude Code dans VSCode. Le générateur ne se termine
 * toujours que sur `close()`.
 *
 * T-064 — `push()` porte aussi des pièces jointes (`buildUserMessage` les
 * construit déjà) ; sans point d'injection après, ni texte ni images ne sont
 * jamais vus — voir `push_perdu` (T-087, poussesEnAttente.ts).
 */
export function createTurnPrompt(
  promptText: string,
  attachments: Attachment[],
): {
  iterable: AsyncIterable<Record<string, unknown>>;
  push: (text: string, pushedAttachments: Attachment[]) => void;
  close: () => void;
} {
  const queued: Record<string, unknown>[] = [];
  let closed = false;
  // Réveil du générateur suspendu : `null` quand personne n'attend (push
  // avant la première suspension → le message reste simplement dans `queued`).
  let wake: (() => void) | null = null;

  function signal(): void {
    const resolve = wake;
    wake = null;
    resolve?.();
  }

  async function* gen(): AsyncGenerator<Record<string, unknown>> {
    yield buildUserMessage(promptText, attachments);
    while (true) {
      while (queued.length > 0) {
        yield queued.shift() as Record<string, unknown>;
      }
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    iterable: gen(),
    push: (text: string, pushedAttachments: Attachment[]) => {
      if (closed) {
        return;
      }
      queued.push(buildUserMessage(text, pushedAttachments));
      signal();
    },
    close: () => {
      closed = true;
      signal();
    },
  };
}
