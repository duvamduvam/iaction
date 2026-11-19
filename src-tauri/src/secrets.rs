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
use tauri::AppHandle;

use crate::coffre::Etat;
use crate::coffre_commandes;

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

// ---------------------------------------------------------------------------
// Trousseau brut — utilisé par le coffre pour la classe `sans-fenetre` et
// pour retirer la copie d'avant le coffre (coffre_commandes.rs).
// ---------------------------------------------------------------------------

/// Écrit au trousseau, sans passer par le coffre.
pub(crate) fn trousseau_poser(account: &str, value: &str) -> Result<(), String> {
    entry_for(account)?
        .set_password(value)
        .map_err(|err| format!("échec de l'écriture dans le trousseau pour « {account} » : {err}"))
}

/// Lit le trousseau (service courant, puis l'ancien). `Ok(None)` : absent.
pub(crate) fn trousseau_lire(account: &str) -> Result<Option<String>, String> {
    match entry_for(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(lire_ancien(account)),
        Err(err) => Err(format!("échec de la lecture du trousseau pour « {account} » : {err}")),
    }
}

/// Retire du trousseau, sous les deux noms de service. Best-effort : une
/// entrée absente ou un trousseau indisponible ne sont pas des erreurs ici.
pub(crate) fn trousseau_retirer(account: &str) {
    if let Ok(ancien) = Entry::new(LEGACY_SERVICE, account) {
        let _ = ancien.delete_credential();
    }
    if let Ok(entry) = entry_for(account) {
        let _ = entry.delete_credential();
    }
}

// ---------------------------------------------------------------------------
// Commandes Tauri — signatures inchangées pour l'interface (`account`, `value`).
//
// Depuis le coffre (docs/etude-coffre-secrets.md § 4.2) :
// - coffre ABSENT (pas encore créé sur ce poste) : trousseau, comme avant ;
// - coffre OUVERT : le coffre répond pour la classe `coffre` ; la classe
//   `sans-fenetre` reste au trousseau ;
// - coffre VERROUILLÉ : lecture au trousseau seulement (secrets pas encore
//   migrés, ou `sans-fenetre`) ; écriture et suppression refusées, pour ne
//   jamais créer de copie divergente hors du coffre.
// ---------------------------------------------------------------------------

/// Commande Tauri : enregistre (ou remplace) le secret associé à `account`.
#[tauri::command]
pub fn secret_set(app: AppHandle, account: String, value: String) -> Result<(), String> {
    match coffre_commandes::etat(&app) {
        Etat::Absent => trousseau_poser(&account, &value),
        Etat::Verrouille => Err(format!(
            "coffre verrouillé : déverrouille-le pour enregistrer « {account} »"
        )),
        Etat::Ouvert => coffre_commandes::poser(&app, &account, &value).map(|_| ()),
    }
}

/// Commande Tauri : lit le secret associé à `account`. Une entrée absente n'est pas
/// une erreur : elle renvoie `Ok(None)`.
///
/// Le coffre ouvert répond d'abord. Sinon, trousseau : c'est la place des
/// secrets `sans-fenetre` (lisibles coffre fermé, par choix), et celle de
/// tout secret d'un poste qui n'a pas encore créé son coffre. Absente du
/// service courant, la clé est cherchée sous l'ancien nom et migrée (voir
/// l'en-tête). Coffre fermé, une clé qui n'existe QUE dans le coffre lit
/// `None` : les modèles locaux restent utilisables, et l'interface repousse
/// ses fournisseurs au déverrouillage (événement `coffre:etat`). Après la
/// migration (coffre_gestion.rs), une clé de classe `coffre` n'a plus de copie
/// au trousseau : ce chemin ne la retrouve donc pas.
#[tauri::command]
pub fn secret_get(app: AppHandle, account: String) -> Result<Option<String>, String> {
    if let Some(valeur) = coffre_commandes::lire_pour_secret_get(&app, &account)? {
        return Ok(Some(valeur));
    }
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
pub fn secret_delete(app: AppHandle, account: String) -> Result<(), String> {
    match coffre_commandes::etat(&app) {
        Etat::Verrouille => {
            return Err(format!(
                "coffre verrouillé : déverrouille-le pour supprimer « {account} »"
            ))
        }
        Etat::Ouvert => {
            coffre_commandes::retirer(&app, &account)?;
        }
        Etat::Absent => {}
    }
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
