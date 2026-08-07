import { isNonEmptyString, isPlainObject } from "./base.js";
/**
 * Pièces jointes (`chat.send`, `claude.start`) — validation et gabarits
 * partagés entre le moteur neutre (engine.ts) et le moteur Claude (claude.ts).
 * Voir docs/protocol.md, section « Pièces jointes (`chat.send`, `claude.send`) ».
 *
 * Règle absolue : les octets de pièces jointes ne sont jamais logués ni
 * persistés ici — uniquement validés puis renvoyés à l'appelant, qui les
 * transmet au fournisseur/SDK pour la durée du tour seulement.
 */

export const ALLOWED_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AllowedImageMediaType = (typeof ALLOWED_IMAGE_MEDIA_TYPES)[number];

/** Limites du contrat (voir docs/protocol.md, section Pièces jointes). */
export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES_DECODED = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export interface ImageAttachment {
  kind: "image";
  name: string;
  mediaType: AllowedImageMediaType;
  data: string;
}

export interface TextAttachment {
  kind: "text";
  name: string;
  content: string;
}

export type Attachment = ImageAttachment | TextAttachment;

export type AttachmentValidation =
  | { ok: true; attachments: Attachment[] }
  | { ok: false; message: string };


function isAllowedImageMediaType(value: unknown): value is AllowedImageMediaType {
  return typeof value === "string" && (ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * Taille décodée approximative d'une chaîne base64 : 3/4 de sa longueur (voir
 * docs/protocol.md). Approximation volontaire (ignore le padding exact) —
 * suffisante pour une garde-fou avant tout appel réseau/SDK.
 */
function estimateBase64DecodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 100) / 100} Mo`;
}

/**
 * Valide `params.attachments`. `undefined` est un cas valide (aucune pièce
 * jointe : comportement des moteurs strictement inchangé) et renvoie un
 * tableau vide. Toute autre valeur doit être un tableau d'au plus
 * MAX_ATTACHMENTS entrées conformes au contrat — la première non-conformité
 * rencontrée produit un message d'erreur français précis.
 */
export function validateAttachments(value: unknown): AttachmentValidation {
  if (value === undefined) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: "params.attachments doit être un tableau" };
  }
  if (value.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      message: `trop de pièces jointes (${value.length}), maximum ${MAX_ATTACHMENTS} par message`,
    };
  }

  const attachments: Attachment[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const label = `pièce jointe #${i + 1}`;
    if (!isPlainObject(raw)) {
      return { ok: false, message: `${label} invalide : objet attendu` };
    }

    if (raw.kind === "image") {
      if (!isNonEmptyString(raw.name)) {
        return { ok: false, message: `${label} : "name" manquant ou invalide` };
      }
      if (!isAllowedImageMediaType(raw.mediaType)) {
        return {
          ok: false,
          message: `${label} ("${raw.name}") : type d'image non autorisé (attendu ${ALLOWED_IMAGE_MEDIA_TYPES.join(", ")})`,
        };
      }
      if (!isNonEmptyString(raw.data)) {
        return { ok: false, message: `${label} ("${raw.name}") : "data" (base64) manquant ou invalide` };
      }
      const decodedBytes = estimateBase64DecodedBytes(raw.data);
      if (decodedBytes > MAX_IMAGE_BYTES_DECODED) {
        return {
          ok: false,
          message: `${label} ("${raw.name}") : image trop volumineuse (${megabytes(decodedBytes)} décodés, maximum ${megabytes(MAX_IMAGE_BYTES_DECODED)})`,
        };
      }
      attachments.push({ kind: "image", name: raw.name, mediaType: raw.mediaType, data: raw.data });
    } else if (raw.kind === "text") {
      if (!isNonEmptyString(raw.name)) {
        return { ok: false, message: `${label} : "name" manquant ou invalide` };
      }
      if (typeof raw.content !== "string") {
        return { ok: false, message: `${label} ("${raw.name}") : "content" manquant ou invalide` };
      }
      const byteLength = Buffer.byteLength(raw.content, "utf8");
      if (byteLength > MAX_TEXT_BYTES) {
        return {
          ok: false,
          message: `${label} ("${raw.name}") : document texte trop volumineux (${megabytes(byteLength)}, maximum ${megabytes(MAX_TEXT_BYTES)})`,
        };
      }
      attachments.push({ kind: "text", name: raw.name, content: raw.content });
    } else {
      return { ok: false, message: `${label} : "kind" invalide (attendu "image" ou "text")` };
    }
  }

  return { ok: true, attachments };
}

/** Gabarit commun de préfixage d'un document texte joint (voir docs/protocol.md). */
export function formatTextAttachmentPrefix(name: string, content: string): string {
  return `Document joint « ${name} » :\n\`\`\`\n${content}\n\`\`\``;
}

export function isImageAttachment(a: Attachment): a is ImageAttachment {
  return a.kind === "image";
}

export function isTextAttachment(a: Attachment): a is TextAttachment {
  return a.kind === "text";
}
