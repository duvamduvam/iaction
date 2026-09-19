/*
 * Wrapper typé de la commande Tauri de lecture d'image du presse-papier natif
 * (voir `src-tauri/src/clipboard.rs`). Utilisé en REPLI par le composeur quand
 * l'événement `paste` du DOM ne porte aucune image — le cas d'une capture
 * d'écran sous WebKitGTK (moteur Tauri Linux), qui n'expose pas ces octets au
 * navigateur.
 *
 * La commande renvoie les octets PNG bruts (transmis en `ArrayBuffer`, pas en
 * base64 : plus rapide pour plusieurs Mo). Une réponse vide = pas d'image.
 *
 * T-048 — la mesure du temps d'aller-retour (segment 2 du ticket) est prise
 * par l'APPELANT (`collerImageDuPressePapierNatif`, Attachments.tsx), qui la
 * réunit avec les trois autres segments en UNE seule ligne de journal — voir
 * journalCollage.ts. Le détail `get_image()`/`encode_png`, lui, ne peut être
 * chronométré que côté Rust : il part séparément (scope `rust`, même
 * commande, voir clipboard.rs).
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Octets PNG de l'image du presse-papier système, ou `null` s'il n'y a pas
 * d'image (texte, ou presse-papier vide). Peut rejeter hors environnement
 * Tauri (`invoke` absent) ou si le presse-papier est inaccessible — l'appelant
 * traite ces cas comme « pas d'image ».
 */
export async function readClipboardImage(): Promise<Uint8Array | null> {
  const buffer = await invoke<ArrayBuffer>("clipboard_read_image");
  const bytes = new Uint8Array(buffer);
  return bytes.byteLength > 0 ? bytes : null;
}

/**
 * Largeur/hauteur d'un PNG lues directement dans son en-tête `IHDR` (octets
 * 16..24, gros-boutiste) — segment 3 du ticket T-048. Évite de décoder
 * l'image entière (coûteux) pour deux entiers déjà présents dans les 24
 * premiers octets. `null` si le tampon est trop court pour porter un en-tête
 * — jamais une exception : cette fonction sert un point de journal, pas un
 * chemin fonctionnel.
 */
export function dimensionsPng(bytes: Uint8Array): { largeur: number; hauteur: number } | null {
  if (bytes.byteLength < 24) return null;
  const vue = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { largeur: vue.getUint32(16), hauteur: vue.getUint32(20) };
}
