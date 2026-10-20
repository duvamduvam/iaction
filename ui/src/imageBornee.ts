/*
 * T-144 — borner les dimensions d'une image jointe AVANT qu'elle parte au modèle.
 *
 * L'API Anthropic refuse, dans une requête qui porte PLUS DE 20 images, toute
 * image de plus de 2000 px de côté. Le refus ne frappe donc pas au moment de
 * l'envoi : une capture 2464×1508 passe, puis empoisonne la session au tour où
 * l'historique franchit la 21ᵉ image — et chaque reprise rejoue la même erreur
 * (« an image in the conversation could not be processed and was removed »).
 * Constaté le 2026-09-27 sur une session OrgaIA de 23 images.
 *
 * Réduire à 2000 px ne coûte rien : l'API ramène de toute façon les grandes
 * images vers ~1568 px avant de les lire. La réduction se fait ici, à
 * l'entrée des pièces jointes, pour que TOUS les moteurs en profitent.
 */

/** Plus grand côté accepté par l'API au-delà de 20 images par requête. */
export const COTE_MAX_IMAGE = 2000;

/** Dimensions cibles : inchangées si l'image tient déjà, sinon réduites en gardant le ratio. */
export function dimensionsBornees(
  largeur: number,
  hauteur: number,
  coteMax: number = COTE_MAX_IMAGE,
): { largeur: number; hauteur: number; reduite: boolean } {
  const plusGrand = Math.max(largeur, hauteur);
  if (plusGrand <= coteMax) return { largeur, hauteur, reduite: false };
  const echelle = coteMax / plusGrand;
  return {
    largeur: Math.max(1, Math.round(largeur * echelle)),
    hauteur: Math.max(1, Math.round(hauteur * echelle)),
    reduite: true,
  };
}

/**
 * Format de sortie d'une image réduite. PNG/JPEG/WebP gardent le leur ; un GIF
 * redessiné perd son animation de toute façon (le modèle n'en lit que la
 * première image), il devient PNG.
 */
function typeDeSortie(mediaType: string): "image/png" | "image/jpeg" | "image/webp" {
  if (mediaType === "image/jpeg" || mediaType === "image/webp") return mediaType;
  return "image/png";
}

export interface ImageBornee {
  blob: Blob;
  mediaType: string;
  /** Dimensions d'origine, pour dire à l'utilisateur ce qui a été fait. */
  origine: { largeur: number; hauteur: number } | null;
  reduite: boolean;
}

/**
 * Renvoie l'image telle quelle si elle tient dans `COTE_MAX_IMAGE`, sinon une
 * copie réduite. Si le décodage échoue (format exotique, environnement sans
 * `createImageBitmap`), l'image part inchangée : mieux vaut risquer le refus
 * de l'API — que le sidecar signale désormais (T-144) — que de perdre la pièce.
 */
export async function bornerImage(blob: Blob, mediaType: string): Promise<ImageBornee> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { blob, mediaType, origine: null, reduite: false };
  }
  try {
    const origine = { largeur: bitmap.width, hauteur: bitmap.height };
    const cible = dimensionsBornees(origine.largeur, origine.hauteur);
    if (!cible.reduite) return { blob, mediaType, origine, reduite: false };
    const canvas = document.createElement("canvas");
    canvas.width = cible.largeur;
    canvas.height = cible.hauteur;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob, mediaType, origine, reduite: false };
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, cible.largeur, cible.hauteur);
    const sortie = typeDeSortie(mediaType);
    const reduit = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, sortie, 0.92));
    if (!reduit) return { blob, mediaType, origine, reduite: false };
    return { blob: reduit, mediaType: sortie, origine, reduite: true };
  } finally {
    bitmap.close();
  }
}
