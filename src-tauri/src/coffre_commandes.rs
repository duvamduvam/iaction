//! Colle Tauri du coffre de secrets (docs/etude-coffre-secrets.md § 4.2, § 4.3).
//!
//! La coquille est le GARDIEN : seule à connaître la clé, seule à déchiffrer.
//! Ce module expose :
//!
//! - les commandes de l'interface (`coffre_etat`, `coffre_creer`,
//!   `coffre_deverrouiller`, `coffre_deverrouiller_secours`,
//!   `coffre_verrouiller`, `coffre_changer_mot_de_passe`) ;
//! - l'accès des commandes `secret_*` (secrets.rs) au coffre ;
//! - la POUSSÉE de la table des secrets MCP au sidecar (`coffre.charger`), au
//!   déverrouillage, au verrouillage et à chaque (re)naissance du sidecar ;
//! - les demandes d'écriture du sidecar (`coffre:ecrire` / `coffre:retirer`,
//!   interceptées dans la stdout du sidecar, jamais relayées à l'interface),
//!   ACQUITTÉES par `coffre.ecrit {demande, ok, erreur?}` après écriture ET
//!   relecture du coffre sur le disque : le sidecar ne dit « enregistré »
//!   qu'à cet accusé ;
//! - la fermeture automatique (veille, verrouillage de session), qui attend la
//!   fin des tours en cours (`coffre.attendreFin`).
//!
//! Journal : noms, causes et états seulement. Aucune valeur, ni mot de passe.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::coffre::{Classe, Coffre, Erreur, Etat, PREFIXE_MCP};
use crate::journal_coquille::journal_coquille;

/// Préfixe des identifiants de requête que la coquille adresse au sidecar :
/// leurs réponses sont traitées ici et ne remontent pas à l'interface.
pub const PREFIXE_ID: &str = "coffre-";

/// Fermeture différée : sa cause et le nombre de tours qu'elle attend.
#[derive(Serialize, Clone, Debug)]
pub struct Attente {
    pub cause: String,
    pub tours: u64,
}

/// État publié sur l'événement `coffre:etat` et rendu par `coffre_etat`.
#[derive(Serialize, Clone, Debug)]
pub struct EtatPublic {
    pub etat: Etat,
    pub attente: Option<Attente>,
    /// Ouvert sur la version précédente (`coffre.age` illisible) : la
    /// dernière modification est perdue. L'interface le dit.
    #[serde(rename = "repliPrecedent")]
    pub repli_precedent: bool,
}

pub struct CoffreGere {
    coffre: Option<Coffre>,
    attente: Option<Attente>,
}

pub type EtatGere = Mutex<CoffreGere>;

pub fn managed_state() -> EtatGere {
    Mutex::new(CoffreGere { coffre: None, attente: None })
}

static COMPTEUR: AtomicU64 = AtomicU64::new(1);

fn nouvel_id(genre: &str) -> String {
    format!("{PREFIXE_ID}{genre}-{}", COMPTEUR.fetch_add(1, Ordering::Relaxed))
}

fn verrou(app: &AppHandle) -> MutexGuard<'_, CoffreGere> {
    let etat = app.state::<EtatGere>();
    // `State` emprunte l'AppHandle : le garde vit aussi longtemps que lui.
    let etat: &EtatGere = etat.inner();
    match etat.lock() {
        Ok(g) => g,
        Err(empoisonne) => empoisonne.into_inner(),
    }
}

/// Exécute `f` sur le coffre du poste (créé paresseusement sur le dossier de config).
pub fn avec_coffre<T>(app: &AppHandle, f: impl FnOnce(&mut Coffre) -> T) -> Result<T, String> {
    let mut g = verrou(app);
    if g.coffre.is_none() {
        let dossier = crate::config_store::app_config_dir(app)?;
        g.coffre = Some(Coffre::nouveau(dossier));
    }
    let coffre = g.coffre.as_mut().ok_or_else(|| "coffre indisponible".to_string())?;
    Ok(f(coffre))
}

fn etat_public(app: &AppHandle) -> EtatPublic {
    let (etat, repli_precedent) = avec_coffre(app, |c| (c.etat(), c.repli_precedent())).unwrap_or((Etat::Absent, false));
    let attente = verrou(app).attente.clone();
    EtatPublic { etat, attente, repli_precedent }
}

fn publier(app: &AppHandle) {
    let _ = app.emit("coffre:etat", etat_public(app));
}

/// Écrit une requête de la coquille sur le stdin du sidecar (même canal que
/// `sidecar_request`). La ligne peut porter des valeurs : jamais journalisée.
fn ecrire_requete(app: &AppHandle, requete: Value) -> Result<(), String> {
    crate::sidecar::sidecar_request(requete, app.state::<crate::sidecar::SharedState>())
}

pub(crate) fn journal(app: &AppHandle, niveau: &str, msg: &str, champs: Value) {
    journal_coquille(app, niveau, msg, &champs);
    crate::sidecar::log_app(app, niveau, msg.to_string(), champs);
}

// ---------------------------------------------------------------------------
// Poussée au sidecar
// ---------------------------------------------------------------------------

/// Pousse au sidecar l'état du coffre et la table des secrets MCP : ceux de
/// classe `coffre` s'il est ouvert, et les `sans-fenetre` (trousseau) dans
/// tous les cas — leur raison d'être est de servir coffre fermé. Coffre
/// absent : `etat: "absent"`, le sidecar lit l'ancien fichier (poste qui n'a
/// pas encore créé son coffre). Sans sidecar vivant, rien à faire : la
/// supervision rappellera cette fonction à la naissance du suivant.
pub fn pousser_au_sidecar(app: &AppHandle) {
    let (etat, table) = match avec_coffre(app, |c| (c.etat(), c.table_mcp().ok())) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut secrets = if etat == Etat::Absent {
        std::collections::BTreeMap::new()
    } else {
        crate::coffre_gestion::secrets_sans_fenetre_mcp(app)
    };
    secrets.extend(table.unwrap_or_default());
    let nombre = secrets.len();
    let requete = json!({
        "id": nouvel_id("charger"),
        "method": "coffre.charger",
        "params": { "etat": etat, "secrets": secrets },
    });
    if let Err(err) = ecrire_requete(app, requete) {
        // Pas d'erreur visible : sidecar en (re)démarrage, il sera servi à sa naissance.
        journal_coquille(
            app,
            "info",
            "table du coffre non poussée : sidecar indisponible",
            &json!({ "erreur": err }),
        );
        return;
    }
    journal_coquille(app, "info", "table du coffre poussée au sidecar", &json!({ "etat": etat, "secrets": nombre }));
}

/// Lignes de la stdout du sidecar destinées à la coquille. Renvoie `true` si
/// la ligne a été consommée ici (elle ne doit PAS être relayée à l'interface :
/// une demande d'écriture porte une valeur).
pub fn intercepter_sortie_sidecar(app: &AppHandle, ligne: &Value) -> bool {
    let evenement = ligne.get("event").and_then(Value::as_str).unwrap_or("");
    match evenement {
        "coffre:ecrire" | "coffre:retirer" => {
            ecriture_demandee_par_sidecar(app, evenement, ligne.get("data").unwrap_or(&Value::Null));
            return true;
        }
        _ => {}
    }
    let Some(id) = ligne.get("id").and_then(Value::as_str) else {
        return false;
    };
    if !id.starts_with(PREFIXE_ID) {
        return false;
    }
    if id.starts_with(&format!("{PREFIXE_ID}attente-")) {
        suivre_attente(app, evenement, ligne.get("data"));
    } else if evenement == "error" {
        journal(app, "error", "le sidecar a refusé une requête du coffre", json!({ "id": id, "erreur": ligne.get("data").and_then(|d| d.get("message")) }));
    }
    true
}

/// Demande d'écriture du sidecar, lue depuis `data`.
#[derive(Debug, PartialEq, Eq)]
pub struct Demande {
    /// Identifiant à rendre dans l'accusé (`None` : sidecar ancien, sans accusé).
    pub demande: Option<String>,
    pub nom: String,
    /// `Some` pour `coffre:ecrire`, `None` pour `coffre:retirer`.
    pub valeur: Option<String>,
}

/// Lit une demande `coffre:ecrire` / `coffre:retirer`. Pure (testée).
pub fn lire_demande(evenement: &str, data: &Value) -> Result<Demande, String> {
    let demande = data.get("demande").and_then(Value::as_str).map(str::to_owned);
    let nom = data
        .get("nom")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)))
        .ok_or_else(|| "demande d'écriture sans nom valide".to_string())?
        .to_owned();
    let valeur = if evenement == "coffre:ecrire" {
        let v = data.get("valeur").and_then(Value::as_str).filter(|v| !v.is_empty());
        Some(v.ok_or_else(|| "demande d'écriture sans valeur".to_string())?.to_owned())
    } else {
        None
    };
    Ok(Demande { demande, nom, valeur })
}

/// Requête d'accusé envoyée au sidecar. Pure (testée). L'erreur ne cite que
/// des noms et des causes : jamais la valeur.
pub fn requete_accuse(id: &str, demande: &str, resultat: &Result<(), String>) -> Value {
    let mut params = json!({ "demande": demande, "ok": resultat.is_ok() });
    if let Err(e) = resultat {
        params["erreur"] = json!(e);
    }
    json!({ "id": id, "method": "coffre.ecrit", "params": params })
}

/// `mcp.secretSet` / `mcp.secretDelete` côté sidecar (et le catalogue MCP,
/// la migration des `.env`) passent par ici : la coquille écrit le coffre, le
/// RELIT sur le disque, repousse la table, puis acquitte.
fn ecriture_demandee_par_sidecar(app: &AppHandle, evenement: &str, data: &Value) {
    let lue = lire_demande(evenement, data);
    let (demande, resultat, nom) = match lue {
        Err(e) => {
            journal(app, "warn", "demande d'écriture du sidecar invalide, ignorée", json!({ "cause": e }));
            (data.get("demande").and_then(Value::as_str).map(str::to_owned), Err(e), String::new())
        }
        Ok(Demande { demande, nom, mut valeur }) => {
            let compte = format!("{PREFIXE_MCP}{nom}");
            let r = match valeur.as_deref() {
                Some(v) => poser(app, &compte, v).map(|_| ()),
                None => retirer(app, &compte).map(|_| ()),
            };
            if let Some(v) = valeur.as_mut() {
                zeroize::Zeroize::zeroize(v);
            }
            // Relecture SUR LE DISQUE : « enregistré » veut dire relu.
            let r = r.and_then(|_| match avec_coffre(app, |c| c.disque_conforme(&compte)) {
                Ok(Ok(true)) => Ok(()),
                Ok(Ok(false)) => Err("relecture du coffre non conforme".to_string()),
                Ok(Err(e)) => Err(e.to_string()),
                Err(e) => Err(e),
            });
            (demande, r, nom)
        }
    };
    match &resultat {
        Ok(()) => journal(
            app,
            "info",
            if evenement == "coffre:ecrire" { "secret MCP enregistré au coffre" } else { "secret MCP retiré du coffre" },
            json!({ "nom": nom }),
        ),
        Err(err) => journal(app, "error", "écriture du coffre demandée par le sidecar : échec", json!({ "nom": nom, "erreur": err })),
    }
    // Dans les deux cas : la table du sidecar reflète le coffre RÉEL, AVANT
    // l'accusé (le tour suivant voit donc l'état relu).
    pousser_au_sidecar(app);
    if let Some(demande) = demande {
        if let Err(e) = ecrire_requete(app, requete_accuse(&nouvel_id("ecrit"), &demande, &resultat)) {
            journal(app, "warn", "accusé d'écriture non transmis au sidecar", json!({ "erreur": e }));
        }
    }
}

// ---------------------------------------------------------------------------
// Accès des commandes secret_* (secrets.rs)
// ---------------------------------------------------------------------------

/// Lecture d'un compte par `secret_get`. `Ok(Some(v))` = le coffre répond ;
/// `Ok(None)` = le coffre ne connaît pas ce compte (ou il est `sans-fenetre`,
/// ou le coffre est verrouillé) : l'appelant lit alors le trousseau.
pub fn lire_pour_secret_get(app: &AppHandle, compte: &str) -> Result<Option<String>, String> {
    avec_coffre(app, |c| match c.etat() {
        Etat::Ouvert => c.lire(compte).map_err(String::from),
        _ => Ok(None),
    })?
}

/// Classe connue d'un compte, coffre ouvert. `None` partout ailleurs.
pub fn classe(app: &AppHandle, compte: &str) -> Option<Classe> {
    avec_coffre(app, |c| c.classe(compte).ok().flatten()).ok().flatten()
}

pub fn etat(app: &AppHandle) -> Etat {
    avec_coffre(app, |c| c.etat()).unwrap_or(Etat::Absent)
}

/// Pose une valeur au coffre (classe conservée, `coffre` par défaut).
pub fn poser(app: &AppHandle, compte: &str, valeur: &str) -> Result<Classe, String> {
    let classe = classe(app, compte).unwrap_or_default();
    if classe == Classe::SansFenetre {
        crate::secrets::trousseau_poser(compte, valeur)?;
    }
    avec_coffre(app, |c| c.poser(compte, valeur, classe).map_err(String::from))??;
    if classe == Classe::Coffre {
        // La copie au trousseau (d'avant le coffre) n'a plus lieu d'être.
        // Après l'écriture réussie du coffre, jamais avant.
        crate::secrets::trousseau_retirer(compte);
    }
    Ok(classe)
}

pub fn retirer(app: &AppHandle, compte: &str) -> Result<bool, String> {
    let existait = avec_coffre(app, |c| c.retirer(compte).map_err(String::from))??;
    crate::secrets::trousseau_retirer(compte);
    // L'index des `sans-fenetre` ne doit pas garder un nom fantôme (avertissement
    // « absent du trousseau » à chaque poussée sinon).
    let d = crate::config_store::app_config_dir(app)?;
    let mut index = crate::coffre_gestion::lire_index(&d);
    if index.remove(compte) {
        crate::coffre_gestion::ecrire_index(&d, &index)?;
    }
    Ok(existait)
}

// ---------------------------------------------------------------------------
// Commandes de l'interface
// ---------------------------------------------------------------------------

fn apres_ouverture(app: &AppHandle, comment: &str) {
    verrou(app).attente = None;
    journal(app, "info", "coffre ouvert", json!({ "par": comment }));
    if avec_coffre(app, |c| c.repli_precedent()).unwrap_or(false) {
        journal(
            app,
            "warn",
            "coffre.age illisible : coffre ouvert sur sa version précédente, la dernière modification est perdue",
            json!({}),
        );
    }
    pousser_au_sidecar(app);
    publier(app);
}

#[tauri::command]
pub fn coffre_etat(app: AppHandle) -> EtatPublic {
    etat_public(&app)
}

/// Crée le coffre. Renvoie la clé de secours, affichée UNE fois par l'interface.
#[tauri::command]
pub fn coffre_creer(app: AppHandle, mot_de_passe: String) -> Result<String, String> {
    use age::secrecy::ExposeSecret;
    let mut mdp = mot_de_passe;
    let resultat = avec_coffre(&app, |c| c.creer(&mdp));
    zeroize::Zeroize::zeroize(&mut mdp);
    match resultat? {
        Ok(secours) => {
            apres_ouverture(&app, "création");
            Ok(secours.expose_secret().to_owned())
        }
        Err(e) => {
            journal(&app, "warn", "création du coffre refusée", json!({ "cause": e.to_string() }));
            Err(e.into())
        }
    }
}

fn echec_ouverture(app: &AppHandle, par: &str, e: Erreur) -> String {
    journal(app, "warn", "échec d'ouverture du coffre", json!({ "par": par, "cause": e.to_string() }));
    e.into()
}

#[tauri::command]
pub fn coffre_deverrouiller(app: AppHandle, mot_de_passe: String) -> Result<(), String> {
    let mut mdp = mot_de_passe;
    let resultat = avec_coffre(&app, |c| c.deverrouiller(&mdp));
    zeroize::Zeroize::zeroize(&mut mdp);
    match resultat? {
        Ok(()) => {
            apres_ouverture(&app, "mot de passe");
            Ok(())
        }
        Err(e) => Err(echec_ouverture(&app, "mot de passe", e)),
    }
}

#[tauri::command]
pub fn coffre_deverrouiller_secours(app: AppHandle, cle: String) -> Result<(), String> {
    let mut cle = cle;
    let resultat = avec_coffre(&app, |c| c.deverrouiller_secours(&cle));
    zeroize::Zeroize::zeroize(&mut cle);
    match resultat? {
        Ok(()) => {
            apres_ouverture(&app, "clé de secours");
            Ok(())
        }
        Err(e) => Err(echec_ouverture(&app, "clé de secours", e)),
    }
}

#[tauri::command]
pub fn coffre_changer_mot_de_passe(app: AppHandle, ancien: Option<String>, nouveau: String) -> Result<(), String> {
    let mut ancien = ancien;
    let mut nouveau = nouveau;
    let resultat = avec_coffre(&app, |c| c.changer_mot_de_passe(ancien.as_deref(), &nouveau));
    zeroize::Zeroize::zeroize(&mut nouveau);
    if let Some(a) = ancien.as_mut() {
        zeroize::Zeroize::zeroize(a);
    }
    match resultat? {
        Ok(()) => {
            journal(&app, "info", "mot de passe du coffre changé", json!({}));
            Ok(())
        }
        Err(e) => {
            journal(&app, "warn", "changement du mot de passe du coffre refusé", json!({ "cause": e.to_string() }));
            Err(e.into())
        }
    }
}

/// Verrouillage MANUEL : immédiat, même pendant un tour (geste explicite).
/// Les serveurs MCP déjà lancés gardent leur jeton jusqu'à la fin de leur tour.
#[tauri::command]
pub fn coffre_verrouiller(app: AppHandle) {
    fermer(&app, "manuel");
}

// ---------------------------------------------------------------------------
// Fermeture
// ---------------------------------------------------------------------------

fn fermer(app: &AppHandle, cause: &str) {
    let etait_ouvert = avec_coffre(app, |c| {
        let ouvert = c.etat() == Etat::Ouvert;
        c.verrouiller();
        ouvert
    })
    .unwrap_or(false);
    verrou(app).attente = None;
    if etait_ouvert {
        journal(app, "info", "coffre fermé", json!({ "cause": cause }));
        pousser_au_sidecar(app);
    }
    publier(app);
}

/// Fermeture AUTOMATIQUE (veille, verrouillage de session) : attend la fin
/// des tours en cours (§ 4.3). Le sidecar compte ses tours et répond quand il
/// n'en reste aucun ; d'ici là l'en-tête affiche l'attente.
pub fn demander_fermeture(app: &AppHandle, cause: &str) {
    if etat(app) != Etat::Ouvert {
        return;
    }
    {
        let mut g = verrou(app);
        if g.attente.is_some() {
            return; // une fermeture attend déjà
        }
        g.attente = Some(Attente { cause: cause.to_string(), tours: 0 });
    }
    journal(app, "info", "fermeture du coffre demandée", json!({ "cause": cause }));
    let requete = json!({ "id": nouvel_id("attente"), "method": "coffre.attendreFin", "params": {} });
    if ecrire_requete(app, requete).is_err() {
        // Sans sidecar, aucun tour ne peut être en cours.
        fermer(app, cause);
        return;
    }
    publier(app);
}

fn suivre_attente(app: &AppHandle, evenement: &str, data: Option<&Value>) {
    let cause = match verrou(app).attente.as_ref() {
        Some(a) => a.cause.clone(),
        None => return, // déjà fermé (manuellement) ou rouvert
    };
    match evenement {
        "chunk" => {
            let tours = data.and_then(|d| d.get("tours")).and_then(Value::as_u64).unwrap_or(0);
            if let Some(a) = verrou(app).attente.as_mut() {
                a.tours = tours;
            }
            publier(app);
        }
        // `done` (plus aucun tour) ou `error` (sidecar ancien, méthode
        // inconnue) : on ferme. Mieux vaut fermer trop tôt que jamais.
        _ => fermer(app, &cause),
    }
}

/// Le sidecar vient de mourir : une attente en cours ne recevra jamais de
/// réponse. Plus aucun tour ne tourne, on ferme.
pub fn sidecar_perdu(app: &AppHandle) {
    let cause = verrou(app).attente.as_ref().map(|a| a.cause.clone());
    if let Some(cause) = cause {
        fermer(app, &cause);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demande_d_ecriture_lue_et_validee() {
        let d = lire_demande("coffre:ecrire", &json!({ "demande": "d-1", "nom": "relais.jeton", "valeur": "v" })).unwrap();
        assert_eq!(d, Demande { demande: Some("d-1".into()), nom: "relais.jeton".into(), valeur: Some("v".into()) });
        let r = lire_demande("coffre:retirer", &json!({ "nom": "x" })).unwrap();
        assert_eq!(r.valeur, None);
        assert_eq!(r.demande, None, "sidecar ancien : pas d'accusé");
        assert!(lire_demande("coffre:ecrire", &json!({ "nom": "x" })).is_err(), "valeur requise");
        assert!(lire_demande("coffre:ecrire", &json!({ "nom": "", "valeur": "v" })).is_err());
        assert!(lire_demande("coffre:ecrire", &json!({ "nom": "a/b", "valeur": "v" })).is_err(), "nom hors alphabet");
    }

    #[test]
    fn erreur_de_lecture_ne_cite_jamais_la_valeur() {
        let e = lire_demande("coffre:ecrire", &json!({ "nom": "../x", "valeur": "JETON-SECRET-123" })).unwrap_err();
        assert!(!e.contains("JETON-SECRET-123"));
    }

    #[test]
    fn accuse_porte_le_resultat_sans_valeur() {
        let ok = requete_accuse("coffre-ecrit-1", "d-7", &Ok(()));
        assert_eq!(ok["method"], "coffre.ecrit");
        assert_eq!(ok["params"]["demande"], "d-7");
        assert_eq!(ok["params"]["ok"], true);
        assert!(ok["params"].get("erreur").is_none());
        let ko = requete_accuse("coffre-ecrit-2", "d-8", &Err("coffre verrouillé".into()));
        assert_eq!(ko["params"]["ok"], false);
        assert_eq!(ko["params"]["erreur"], "coffre verrouillé");
        assert!(ko["id"].as_str().unwrap().starts_with(PREFIXE_ID), "réponse interceptée, jamais relayée");
    }
}
