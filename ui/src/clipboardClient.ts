/*
 * Wrapper typé de la commande Tauri de lecture d'image du presse-papier natif
 * (voir `src-tauri/src/clipboard.rs`). Utilisé en REPLI par le composeur quand
 * l'événement `paste` du DOM ne porte aucune image — le cas d'une capture
 * d'écran sous WebKitGTK (moteur Tauri Linux), qui n'expose pas ces octets au
 * navigateur.
 *
 * La commande renvoie les octets PNG bruts (transmis en `ArrayBuffer`, pas en
 * base64 : plus rapide pour plusieurs Mo). Une réponse vide = pas d'image.
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
