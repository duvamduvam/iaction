//! Commandes Tauri pour le trousseau OS (`keyring`), hors relais sidecar.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri hors relais (Lot 1) ». Sert
//! uniquement à stocker/lire/supprimer des secrets (clés API des fournisseurs) sous le
//! service `"iaction"`, avec la convention de compte `provider:<id>`. Le Rust ne
//! connaît pas la sémantique des valeurs : il relaie vers le trousseau du système
//! (Secret Service sur Linux, Keychain sur macOS, Credential Manager sur Windows).

use keyring::{Entry, Error as KeyringError};

/// Nom de service utilisé pour toutes les entrées du trousseau créées par IAction.
const SERVICE: &str = "iaction";

/// Construit l'entrée de trousseau pour un compte donné.
fn entry_for(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account)
        .map_err(|err| format!("échec de l'ouverture du trousseau pour « {account} » : {err}"))
}

/// Commande Tauri : enregistre (ou remplace) le secret associé à `account`.
#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    let entry = entry_for(&account)?;
    entry
        .set_password(&value)
        .map_err(|err| format!("échec de l'écriture dans le trousseau pour « {account} » : {err}"))
}

/// Commande Tauri : lit le secret associé à `account`. Une entrée absente n'est pas
/// une erreur : elle renvoie `Ok(None)`.
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    let entry = entry_for(&account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!(
            "échec de la lecture du trousseau pour « {account} » : {err}"
        )),
    }
}

/// Commande Tauri : supprime le secret associé à `account`. Idempotent : une entrée
/// déjà absente n'est pas une erreur.
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    let entry = entry_for(&account)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!(
            "échec de la suppression dans le trousseau pour « {account} » : {err}"
        )),
    }
}
