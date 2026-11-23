//! Déverrouillage automatique du coffre sur ce poste (T-225 ;
//! docs/etude-coffre-secrets.md § 3, ligne D, rouverte le 2026-11-19).
//!
//! L'identité X25519 du coffre est rangée au trousseau du système (service
//! `iaction`, compte `coffre:deverrouillage-auto`), ouvert à la connexion de
//! l'utilisateur : au lancement, le coffre se rouvre sans mot de passe.
//!
//! - **Interdit** sur un Windows joint à un domaine — la protection du
//!   trousseau y relève du domaine (§ 3) — et quand la jonction est
//!   indéterminée, par prudence. Une entrée trouvée sur un tel poste est
//!   retirée au lancement.
//! - Une entrée qui n'ouvre plus le coffre (coffre recréé, fichier abîmé) est
//!   retirée : le mot de passe reprend la main, et le journal le dit.
//! - Tant qu'il est actif, la fermeture à la veille et au verrouillage de
//!   session ne ferme pas le coffre (coffre_veille.rs) : elle ne protégerait
//!   rien, le trousseau le rouvrirait. Le verrouillage MANUEL reste immédiat.
//!
//! Journal : états et causes seulement. Jamais l'identité.

use age::secrecy::ExposeSecret;
use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;
use zeroize::Zeroize;

use crate::coffre::Etat;
use crate::coffre_commandes::{apres_ouverture, avec_coffre, journal};
use crate::coffre_gestion::poste_joint_domaine;

/// Même service que les autres entrées d'IAction (secrets.rs).
const SERVICE: &str = "iaction";
const COMPTE: &str = "coffre:deverrouillage-auto";

const PAR: &str = "déverrouillage automatique";
const REFUS_DOMAINE: &str = "déverrouillage automatique refusé : poste joint à un domaine (ou indéterminé)";

/// Le déverrouillage automatique n'est permis que sur un poste dont on SAIT
/// qu'il n'est pas joint à un domaine.
pub fn auto_permis(domaine: Option<bool>) -> bool {
    domaine == Some(false)
}

fn permis() -> bool {
    auto_permis(poste_joint_domaine())
}

fn entree() -> Result<Entry, String> {
    Entry::new(SERVICE, COMPTE).map_err(|e| format!("trousseau indisponible : {e}"))
}

/// Identité rangée au trousseau. `Ok(None)` : aucune entrée.
fn lire() -> Result<Option<String>, String> {
    match entree()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("lecture du trousseau impossible : {e}")),
    }
}

fn present() -> Result<bool, String> {
    Ok(lire()?.map(|mut v| v.zeroize()).is_some())
}

fn retirer() -> Result<(), String> {
    match entree()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("retrait du trousseau impossible : {e}")),
    }
}

/// Retire l'entrée et le dit. Un retrait qui échoue est dit aussi.
fn retirer_et_dire(app: &AppHandle, msg: &str, cause: Option<String>) {
    journal(app, "warn", msg, json!({ "cause": cause }));
    if let Err(e) = retirer() {
        journal(app, "error", "entrée du déverrouillage automatique non retirée du trousseau", json!({ "erreur": e }));
    }
}

/// Ouvre le coffre par l'identité `identite` (effacée ensuite). Une identité
/// que le coffre refuse est périmée : l'entrée est retirée.
fn ouvrir_par(app: &AppHandle, mut identite: String) -> Result<(), String> {
    let resultat = avec_coffre(app, |c| c.deverrouiller_par_identite(&identite));
    identite.zeroize();
    match resultat {
        Ok(Ok(())) => {
            apres_ouverture(app, PAR);
            Ok(())
        }
        // Coffre inaccessible (dossier de config) : l'entrée n'est pas en cause.
        Err(e) => {
            journal(app, "warn", "échec d'ouverture du coffre", json!({ "par": PAR, "cause": e }));
            Err(e)
        }
        Ok(Err(e)) => {
            let e = e.to_string();
            retirer_et_dire(app, "déverrouillage automatique impossible : entrée retirée du trousseau", Some(e.clone()));
            Err(e)
        }
    }
}

/// Le déverrouillage automatique est-il en vigueur ici (entrée présente ET
/// poste permis) ? Consulté par la fermeture à la veille (coffre_veille.rs).
pub fn actif_ici() -> Result<bool, String> {
    Ok(permis() && present()?)
}

/// Au lancement, dans le `setup`, avant que l'interface ne demande l'état du
/// coffre : rouvre le coffre si une entrée existe et que le poste le permet.
pub fn tenter_au_lancement(app: &AppHandle) {
    let mut identite = match lire() {
        Ok(Some(i)) => i,
        Ok(None) => return,
        Err(e) => {
            journal(app, "warn", "déverrouillage automatique : trousseau illisible au lancement, coffre verrouillé", json!({ "erreur": e }));
            return;
        }
    };
    let etat = avec_coffre(app, |c| c.etat());
    if !permis() {
        identite.zeroize();
        retirer_et_dire(app, "déverrouillage automatique retiré : poste joint à un domaine (ou indéterminé)", None);
        return;
    }
    match etat {
        Ok(Etat::Verrouille) => {
            // Échec déjà journalisé, entrée retirée : le coffre reste verrouillé.
            let _ = ouvrir_par(app, identite);
        }
        Ok(Etat::Ouvert) => identite.zeroize(),
        Ok(Etat::Absent) => {
            identite.zeroize();
            retirer_et_dire(app, "déverrouillage automatique retiré : aucun coffre sur ce poste", None);
        }
        Err(e) => {
            identite.zeroize();
            journal(app, "warn", "déverrouillage automatique : coffre indisponible au lancement", json!({ "erreur": e }));
        }
    }
}

// ---------------------------------------------------------------------------
// Commandes de l'interface
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug)]
pub struct EtatAuto {
    pub actif: bool,
    pub permis: bool,
}

#[tauri::command]
pub fn coffre_auto_etat() -> Result<EtatAuto, String> {
    Ok(EtatAuto { actif: present()?, permis: permis() })
}

/// Range l'identité du coffre OUVERT au trousseau.
#[tauri::command]
pub fn coffre_auto_activer(app: AppHandle) -> Result<(), String> {
    let resultat = (|| {
        if !permis() {
            return Err(REFUS_DOMAINE.to_string());
        }
        let identite = avec_coffre(&app, |c| c.identite_courante())?.map_err(String::from)?;
        entree()?
            .set_password(identite.expose_secret())
            .map_err(|e| format!("écriture au trousseau impossible : {e}"))
    })();
    match &resultat {
        Ok(()) => journal(&app, "info", "déverrouillage automatique activé", json!({})),
        Err(e) => journal(&app, "warn", "activation du déverrouillage automatique refusée", json!({ "cause": e })),
    }
    resultat
}

#[tauri::command]
pub fn coffre_auto_desactiver(app: AppHandle) -> Result<(), String> {
    let resultat = retirer();
    match &resultat {
        Ok(()) => journal(&app, "info", "déverrouillage automatique désactivé", json!({})),
        Err(e) => journal(&app, "warn", "désactivation du déverrouillage automatique impossible", json!({ "cause": e })),
    }
    resultat
}

/// Rouvre le coffre par le trousseau, après un verrouillage manuel.
#[tauri::command]
pub fn coffre_auto_ouvrir(app: AppHandle) -> Result<(), String> {
    if !permis() {
        retirer_et_dire(&app, "déverrouillage automatique retiré : poste joint à un domaine (ou indéterminé)", None);
        return Err(REFUS_DOMAINE.to_string());
    }
    match lire() {
        Ok(Some(identite)) => ouvrir_par(&app, identite),
        Ok(None) => {
            let e = "aucune clé de déverrouillage automatique au trousseau".to_string();
            journal(&app, "warn", "échec d'ouverture du coffre", json!({ "par": PAR, "cause": e }));
            Err(e)
        }
        Err(e) => {
            journal(&app, "warn", "échec d'ouverture du coffre", json!({ "par": PAR, "cause": e }));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::auto_permis;

    #[test]
    fn permis_seulement_hors_domaine_connu() {
        assert!(auto_permis(Some(false)));
        assert!(!auto_permis(Some(true)), "Windows joint à un domaine");
        assert!(!auto_permis(None), "jonction indéterminée : refus par prudence");
    }
}
