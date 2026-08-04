//! Lecture d'image du presse-papier SYSTÈME, côté natif.
//!
//! Sous WebKitGTK (le moteur webview de Tauri sous Linux), une capture d'écran
//! présente dans le presse-papier n'est PAS exposée à l'événement `paste` du
//! DOM : `clipboardData.items`/`.files` restent vides. L'UI se rabat alors sur
//! cette commande pour récupérer l'image directement du presse-papier natif,
//! l'encode en PNG et la traite ensuite comme n'importe quelle pièce jointe
//! (voir `readClipboardImage` côté UI et le handler `onPaste` du composeur).
//!
//! Performance : deux choix délibérés pour que la vignette s'affiche vite.
//! 1) Compression PNG `Fast` — sur une grande capture (plusieurs Mpx), la
//!    compression par défaut (zlib niveau ~6) coûte des centaines de ms ; `Fast`
//!    divise ce temps par plusieurs, pour un PNG à peine plus gros — sans objet
//!    ici, l'image n'est pas archivée.
//! 2) Renvoi BINAIRE (`tauri::ipc::Response`) au lieu de base64 : Tauri transmet
//!    alors un `ArrayBuffer`, évitant l'encodage base64 côté Rust ET son
//!    décodage (`atob`) côté JS — coûteux pour des payloads de plusieurs Mo.
//!
//! Best-effort : toute erreur d'accès devient un message français lisible, et
//! l'absence d'image (cas courant : le presse-papier ne contient que du texte)
//! renvoie une réponse VIDE (0 octet), que l'UI interprète comme « pas d'image ».

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};

/// Commande Tauri : renvoie l'image du presse-papier encodée en PNG (octets
/// bruts → `ArrayBuffer` côté JS), ou une réponse VIDE si le presse-papier ne
/// contient pas d'image.
#[tauri::command]
pub fn clipboard_read_image() -> Result<tauri::ipc::Response, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("presse-papier inaccessible : {e}"))?;
    match clipboard.get_image() {
        Ok(image) => Ok(tauri::ipc::Response::new(encode_png(&image)?)),
        // Pas d'image (texte, ou presse-papier vide) : cas normal, pas une
        // erreur — l'UI laissera le collage de texte se faire.
        Err(arboard::Error::ContentNotAvailable) => Ok(tauri::ipc::Response::new(Vec::new())),
        Err(e) => Err(format!(
            "lecture de l'image du presse-papier impossible : {e}"
        )),
    }
}

/// RGBA8 (`arboard::ImageData`) → octets PNG, compression `Fast`. arboard
/// renvoie toujours du RGBA non prémultiplié, ce qu'attend l'encodeur.
fn encode_png(image: &arboard::ImageData) -> Result<Vec<u8>, String> {
    let width = u32::try_from(image.width).map_err(|_| "largeur d'image invalide".to_string())?;
    let height = u32::try_from(image.height).map_err(|_| "hauteur d'image invalide".to_string())?;
    // `write_image` PANIQUE (assert) si le tampon n'a pas exactement
    // width * height * 4 octets. On vérifie donc nous-mêmes pour renvoyer une
    // erreur propre plutôt que de faire tomber le process.
    let expected = image
        .width
        .checked_mul(image.height)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| "dimensions d'image démesurées".to_string())?;
    if image.bytes.len() != expected {
        return Err(format!(
            "tampon d'image incohérent : {} octets pour {}×{} (attendu {expected})",
            image.bytes.len(),
            image.width,
            image.height
        ));
    }
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
        .write_image(&image.bytes, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| format!("encodage PNG impossible : {e}"))?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn encode_png_produit_une_signature_png_valide() {
        // 2×2 RGBA arbitraire (4 octets/pixel).
        let image = arboard::ImageData {
            width: 2,
            height: 2,
            bytes: Cow::Owned(vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ]),
        };
        let png = encode_png(&image).expect("encodage attendu");
        // Signature PNG : 89 50 4E 47 0D 0A 1A 0A.
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn encode_png_rejette_un_tampon_incoherent() {
        // 2×2 = 16 octets attendus, on n'en fournit que 4 : refus propre.
        let image = arboard::ImageData {
            width: 2,
            height: 2,
            bytes: Cow::Owned(vec![255, 0, 0, 255]),
        };
        assert!(encode_png(&image).is_err());
    }
}
