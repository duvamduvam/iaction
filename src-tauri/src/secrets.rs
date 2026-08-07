//! Commandes Tauri pour le trousseau OS (`keyring`), hors relais sidecar.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri hors relais (Lot 1) ». Sert
//! uniquement à stocker/lire/supprimer des secrets (clés API des fournisseurs) sous le
//! service `"iaction"`, avec la convention de compte `provider:<id>`. Le Rust ne
//! connaît pas la sémantique des valeurs : il relaie vers le trousseau du système
//! (Secret Service sur Linux, Keychain sur macOS, Credential Manager sur Windows).
//!
//! ## Renommage du service, et pourquoi il y a un repli
//!
//! Le service s'appelait `"ia-studio"` jusqu'au renommage du produit
//! (2026-08-07). Ce changement a rendu INVISIBLES d'un coup toutes les clés API
//! déjà enregistrées : elles étaient toujours dans le trousseau, mais sous
//! l'ancien nom de service — chaque fournisseur apparaissait sans clé et le chat
//! échouait. Les fichiers, eux, avaient reçu un repli soigné (`appPaths.ts`) ;
//! le trousseau avait été oublié.
//!
//! La lecture retombe donc sur l'ancien service, et **migre l'entrée au
//! passage** : le secret est réécrit sous le nouveau nom puis l'ancienne entrée
//! est supprimée. Une seule lecture suffit à rapatrier une clé, définitivement.
//! Le repli disparaîtra quand plus aucun poste ne portera l'ancien nommage.

use keyring::{Entry, Error as KeyringError};

/// Nom de service utilisé pour toutes les entrées du trousseau créées par IAction.
const SERVICE: &str = "iaction";

/// Ancien nom de service, encore porteur des clés des postes non migrés.
const LEGACY_SERVICE: &str = "ia-studio";

/// Construit l'entrée de trousseau pour un compte donné, sous le service courant.
fn entry_for(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account)
        .map_err(|err| format!("échec de l'ouverture du trousseau pour « {account} » : {err}"))
}

/// Lit le secret sous l'ANCIEN service. Toute erreur (y compris entrée absente)
/// vaut « rien à récupérer » : ce chemin est un rattrapage, il ne doit jamais
/// faire échouer une lecture par ailleurs légitime.
fn lire_ancien(account: &str) -> Option<String> {
    Entry::new(LEGACY_SERVICE, account)
        .ok()?
        .get_password()
        .ok()
}

/// Déplace un secret de l'ancien service vers le nouveau. Best-effort des deux
/// côtés : si la réécriture échoue, on rend quand même la valeur lue (mieux vaut
/// une clé qui marche sans être migrée qu'une clé perdue) ; si la suppression de
/// l'ancienne entrée échoue, elle sera simplement ignorée aux lectures suivantes,
/// le nouveau service ayant désormais la priorité.
fn migrer_depuis_ancien(account: &str, valeur: &str) {
    if let Ok(entry) = Entry::new(SERVICE, account) {
        if entry.set_password(valeur).is_err() {
            return;
        }
    }
    if let Ok(ancien) = Entry::new(LEGACY_SERVICE, account) {
        let _ = ancien.delete_credential();
    }
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
///
/// Absente du service courant, la clé est cherchée sous l'ancien nom et migrée
/// (voir l'en-tête du module).
#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    let entry = entry_for(&account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => match lire_ancien(&account) {
            Some(valeur) => {
                migrer_depuis_ancien(&account, &valeur);
                Ok(Some(valeur))
            }
            None => Ok(None),
        },
        Err(err) => Err(format!(
            "échec de la lecture du trousseau pour « {account} » : {err}"
        )),
    }
}

/// Commande Tauri : supprime le secret associé à `account`. Idempotent : une entrée
/// déjà absente n'est pas une erreur.
///
/// Supprime AUSSI l'entrée de l'ancien service : sans cela, une clé « supprimée »
/// réapparaîtrait à la lecture suivante par le repli de migration.
#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    if let Ok(ancien) = Entry::new(LEGACY_SERVICE, &account) {
        let _ = ancien.delete_credential();
    }
    let entry = entry_for(&account)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!(
            "échec de la suppression dans le trousseau pour « {account} » : {err}"
        )),
    }
}
