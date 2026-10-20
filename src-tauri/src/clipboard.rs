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
//!
//! ── Pourquoi la commande est ASYNCHRONE (T-048) ─────────────────────────
//! Constat utilisateur du 2026-08-14 : coller une capture figeait le composeur
//! ~5 s — pas de vignette, et les touches frappées pendant ce temps perdues. Le
//! symptôme n'était donc pas « le collage est lent » mais « l'interface est
//! gelée » : la vignette « en chargement » est créée de façon SYNCHRONE, avant
//! cet appel, donc si elle n'apparaît pas c'est que rien n'est peint du tout.
//!
//! Une commande Tauri déclarée `fn` — et non `async fn` — s'exécute sur le FIL
//! PRINCIPAL, celui qui porte la boucle GTK, donc l'affichage et les événements
//! de la webview. Or les deux étapes ci-dessous DURENT : la négociation du
//! presse-papier (sous X11/Wayland, le processus qui a fait la capture doit
//! répondre — il peut prendre son temps) puis l'encodage PNG de plusieurs
//! mégapixels. Tant qu'elles tournaient là, la boucle ne rendait pas la main.
//!
//! Le soin déjà pris ci-dessus (compression `Fast`, renvoi binaire) n'y changeait
//! rien, et c'est l'enseignement du ticket : ce n'était pas la DURÉE qui gênait,
//! c'était l'ENDROIT où elle passait. Le travail part donc sur un fil bloquant
//! dédié, et la fenêtre continue de vivre pendant ce temps.
//!
//! ── Mesure T-048 : `get_image()` vs `encode_png` ────────────────────────
//! Le ticket distingue deux causes possibles au segment 2 (l'aller-retour de
//! la commande) : la NÉGOCIATION du presse-papier (le processus propriétaire
//! doit répondre) et l'ENCODAGE PNG lui-même. Seul le code Rust peut les
//! chronométrer l'une sans l'autre ; le résultat part en `info` (visible par
//! défaut — voir `IACTION_LOG_LEVEL`, `docs/protocol.md`) via `log_app`, sur
//! le scope `rust`, en une ligne SÉPARÉE de la ligne récapitulative posée côté
//! UI (`journalCollage.ts`) : deux processus, deux lignes, mais une seule
//! par côté — pas dix par collage.

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use std::time::Instant;

/// Commande Tauri : renvoie l'image du presse-papier encodée en PNG (octets
/// bruts → `ArrayBuffer` côté JS), ou une réponse VIDE si le presse-papier ne
/// contient pas d'image.
///
/// `async` + `spawn_blocking` : voir le paragraphe T-048 de l'en-tête. Le
/// presse-papier n'est ouvert QUE dans la closure, donc rien de non-`Send` ne
/// traverse les fils — seuls les octets du PNG (et la mesure) en reviennent.
///
/// `app: AppHandle` : injecté par Tauri, INVISIBLE de l'appel JS (`invoke`
/// sans argument) — ce paramètre ne change donc rien au contrat de la
/// commande, il sert uniquement à journaliser la mesure ci-dessous.
#[tauri::command]
pub async fn clipboard_read_image(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    let (octets, mesure) = tauri::async_runtime::spawn_blocking(lire_image_presse_papier)
        .await
        .map_err(|e| format!("lecture du presse-papier interrompue : {e}"))??;
    if let Some(m) = mesure {
        crate::sidecar::log_app(
            &app,
            "info",
            "collage : presse-papier lu (rust)".to_string(),
            serde_json::json!({
                "getImageMs": m.get_image_ms,
                "encodePngMs": m.encode_png_ms,
                "octets": octets.len(),
            }),
        );
    }
    Ok(tauri::ipc::Response::new(octets))
}

/// Durée de `get_image()` (négociation du presse-papier) et d'`encode_png`
/// (encodage), chronométrées séparément — voir le paragraphe T-048 ci-dessus.
struct MesureLecture {
    get_image_ms: u64,
    encode_png_ms: u64,
}

/// Le travail bloquant lui-même : ouverture du presse-papier, lecture, encodage.
/// Séparé de la commande pour s'exécuter hors du fil principal — et pour être
/// exerçable sans passer par l'IPC. La mesure n'existe QUE quand une image a
/// été trouvée (`None` sinon : rien à chronométrer côté encodage).
fn lire_image_presse_papier() -> Result<(Vec<u8>, Option<MesureLecture>), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("presse-papier inaccessible : {e}"))?;
    let debut = Instant::now();
    match clipboard.get_image() {
        Ok(image) => {
            let get_image_ms = debut.elapsed().as_millis() as u64;
            let debut_encodage = Instant::now();
            let octets = encode_png(&image)?;
            let encode_png_ms = debut_encodage.elapsed().as_millis() as u64;
            Ok((
                octets,
                Some(MesureLecture {
                    get_image_ms,
                    encode_png_ms,
                }),
            ))
        }
        // Pas d'image (texte, ou presse-papier vide) : cas normal, pas une
        // erreur — l'UI laissera le collage de texte se faire.
        Err(arboard::Error::ContentNotAvailable) => Ok((Vec::new(), None)),
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
