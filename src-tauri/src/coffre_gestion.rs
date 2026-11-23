//! Gestion du coffre — écran des secrets, classes, migration
//! (docs/etude-coffre-secrets.md § 5 et § 7).
//!
//! - `coffre_secrets` : noms, classe, date de création. Jamais de valeur.
//! - `coffre_reclasser` : `coffre` ⇄ `sans-fenetre`. La valeur change de
//!   place (coffre chiffré ⇄ trousseau de l'OS) ; le coffre garde la classe.
//! - `coffre_poste_domaine` : Windows joint à un domaine ? (avertissement § 5)
//! - `coffre_migration_candidats` / `coffre_migrer` : import du trousseau et
//!   de l'ancien `mcp-secrets.json`, classement validé par l'utilisateur,
//!   relecture du coffre SUR LE DISQUE, puis seulement suppression des
//!   originaux (§ 7.3).
//!
//! ## L'index des `sans-fenetre`
//!
//! `<config>/coffre-sans-fenetre.json` liste les NOMS des secrets
//! `sans-fenetre` — aucune valeur. Sans lui, coffre fermé, personne ne
//! saurait quels comptes lire au trousseau : ni la coquille (qui les pousse
//! au sidecar même verrouillée), ni le sidecar d'une tâche de fond, lancé
//! sans coquille (`sidecar/src/trousseauFond.ts`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use zeroize::Zeroize;

use crate::coffre::{Classe, PREFIXE_MCP};
use crate::coffre_commandes::{avec_coffre, journal, pousser_au_sidecar};
use crate::coffre_migration::{migrer, Bilan, Choix, TrousseauSysteme};
use crate::secrets::{trousseau_lire, trousseau_poser, trousseau_retirer};

pub const FICHIER_INDEX: &str = "coffre-sans-fenetre.json";
const FICHIER_MCP_ANCIEN: &str = "mcp-secrets.json";

fn dossier(app: &AppHandle) -> Result<PathBuf, String> {
    crate::config_store::app_config_dir(app)
}

// ---------------------------------------------------------------------------
// Index des noms `sans-fenetre`
// ---------------------------------------------------------------------------

pub fn lire_index(dossier: &Path) -> BTreeSet<String> {
    let Ok(brut) = fs::read_to_string(dossier.join(FICHIER_INDEX)) else {
        return BTreeSet::new();
    };
    serde_json::from_str::<Value>(&brut)
        .ok()
        .and_then(|v| v.get("noms").and_then(Value::as_array).cloned())
        .map(|noms| noms.iter().filter_map(|n| n.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn ecrire_atomique(cible: &Path, contenu: &[u8]) -> Result<(), String> {
    let tmp = cible.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, contenu).map_err(|e| format!("écriture de {} : {e}", cible.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, cible).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("remplacement de {} : {e}", cible.display())
    })
}

pub(crate) fn ecrire_index(dossier: &Path, noms: &BTreeSet<String>) -> Result<(), String> {
    let contenu = serde_json::to_vec_pretty(&json!({ "version": 1, "noms": noms }))
        .map_err(|e| format!("index des secrets sans fenêtre : {e}"))?;
    ecrire_atomique(&dossier.join(FICHIER_INDEX), &contenu)
}

/// Préfixe des scellés du veilleur du relais (T-227) : l'empreinte d'une config
/// approuvée. Un scellé ne vaut que s'il vient du coffre CHIFFRÉ.
pub const PREFIXE_SCELLE: &str = "veilleur.empreinte";

/// Un compte (avec ou sans le préfixe `mcp:`) est-il un scellé du veilleur ?
/// Pure (testée). Un tel secret n'est jamais lu, poussé, reclassé ni migré
/// depuis la classe `sans-fenetre` ou l'ancien fichier en clair : l'index des
/// `sans-fenetre` et le trousseau sont écrivables par un shell du compte, un
/// scellé y serait forgeable.
pub fn est_nom_scelle(compte: &str) -> bool {
    compte.strip_prefix(PREFIXE_MCP).unwrap_or(compte).starts_with(PREFIXE_SCELLE)
}

/// Refus d'un reclassement (pure, testée) : jamais un scellé en `sans-fenetre`.
pub fn reclassement_refuse(compte: &str, classe: Classe) -> Option<String> {
    (classe == Classe::SansFenetre && est_nom_scelle(compte))
        .then(|| format!("« {compte} » est un scellé du veilleur : il reste dans le coffre chiffré"))
}

/// Comptes de l'index réellement lus au trousseau : les scellés en sont exclus.
pub fn comptes_sans_fenetre_lisibles(index: &BTreeSet<String>) -> Vec<&str> {
    index.iter().map(String::as_str).filter(|c| !est_nom_scelle(c)).collect()
}

/// Secrets MCP `sans-fenetre`, lus au trousseau, sous leur nom `${SECRET:…}`.
/// Poussés au sidecar quel que soit l'état du coffre. Jamais un scellé.
pub fn secrets_sans_fenetre_mcp(app: &AppHandle) -> BTreeMap<String, String> {
    let Ok(d) = dossier(app) else { return BTreeMap::new() };
    let index = lire_index(&d);
    for c in index.iter().filter(|c| est_nom_scelle(c)) {
        journal(app, "warn", "scellé du veilleur dans l'index sans fenêtre : ignoré", json!({ "nom": c }));
    }
    let mut out = BTreeMap::new();
    for compte in comptes_sans_fenetre_lisibles(&index) {
        let compte = compte.to_owned();
        let Some(nom) = compte.strip_prefix(PREFIXE_MCP) else { continue };
        match trousseau_lire(&compte) {
            Ok(Some(v)) => {
                out.insert(nom.to_owned(), v);
            }
            Ok(None) => journal(app, "warn", "secret sans fenêtre absent du trousseau", json!({ "nom": compte })),
            Err(e) => journal(app, "warn", "secret sans fenêtre illisible", json!({ "nom": compte, "erreur": e })),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Écran des secrets
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SecretListe {
    nom: String,
    classe: Classe,
    cree: String,
}

#[tauri::command]
pub fn coffre_secrets(app: AppHandle) -> Result<Vec<SecretListe>, String> {
    let liste = avec_coffre(&app, |c| c.liste().map_err(String::from))??;
    Ok(liste.into_iter().map(|(nom, classe, cree)| SecretListe { nom, classe, cree }).collect())
}

/// Change la classe d'un secret. L'ordre protège la valeur : on l'écrit à sa
/// nouvelle place AVANT de la retirer de l'ancienne.
#[tauri::command]
pub fn coffre_reclasser(app: AppHandle, nom: String, classe: Classe) -> Result<(), String> {
    let d = dossier(&app)?;
    let actuelle = avec_coffre(&app, |c| c.classe(&nom).map_err(String::from))??
        .ok_or_else(|| format!("secret inconnu du coffre : « {nom} »"))?;
    if actuelle == classe {
        return Ok(());
    }
    if let Some(refus) = reclassement_refuse(&nom, classe) {
        return Err(refus);
    }
    let mut index = lire_index(&d);
    match classe {
        Classe::SansFenetre => {
            let mut valeur = avec_coffre(&app, |c| c.lire(&nom).map_err(String::from))??
                .ok_or_else(|| format!("valeur absente du coffre : « {nom} »"))?;
            let pose = trousseau_poser(&nom, &valeur);
            valeur.zeroize();
            pose?;
            index.insert(nom.clone());
            ecrire_index(&d, &index)?;
            avec_coffre(&app, |c| c.poser(&nom, "", Classe::SansFenetre).map_err(String::from))??;
        }
        Classe::Coffre => {
            let mut valeur = trousseau_lire(&nom)?
                .ok_or_else(|| format!("valeur absente du trousseau : « {nom} »"))?;
            let pose = avec_coffre(&app, |c| c.poser(&nom, &valeur, Classe::Coffre).map_err(String::from));
            valeur.zeroize();
            pose??;
            trousseau_retirer(&nom);
            index.remove(&nom);
            ecrire_index(&d, &index)?;
        }
    }
    journal(&app, "info", "secret reclassé", json!({ "nom": nom, "classe": classe }));
    pousser_au_sidecar(&app);
    Ok(())
}

/// Windows joint à un domaine Active Directory ? `None` = indéterminé
/// (l'interface avertit alors par prudence). Toujours `Some(false)` ailleurs.
#[tauri::command]
pub fn coffre_poste_domaine() -> Option<bool> {
    poste_joint_domaine()
}

#[cfg(windows)]
pub(crate) fn poste_joint_domaine() -> Option<bool> {
    use windows_sys::Win32::NetworkManagement::NetManagement::{
        NetApiBufferFree, NetGetJoinInformation, NetSetupDomainName, NETSETUP_JOIN_STATUS,
    };
    let mut nom: windows_sys::core::PWSTR = std::ptr::null_mut();
    let mut statut: NETSETUP_JOIN_STATUS = 0;
    // SAFETY : appel documenté, tampon libéré par NetApiBufferFree.
    let code = unsafe { NetGetJoinInformation(std::ptr::null(), &mut nom, &mut statut) };
    if !nom.is_null() {
        unsafe { NetApiBufferFree(nom as *const core::ffi::c_void) };
    }
    if code != 0 {
        return None;
    }
    Some(statut == NetSetupDomainName)
}

#[cfg(not(windows))]
pub(crate) fn poste_joint_domaine() -> Option<bool> {
    Some(false)
}

// ---------------------------------------------------------------------------
// Migration (§ 7)
// ---------------------------------------------------------------------------

fn lire_fichier_mcp(d: &Path) -> BTreeMap<String, String> {
    let Ok(brut) = fs::read_to_string(d.join(FICHIER_MCP_ANCIEN)) else {
        return BTreeMap::new();
    };
    let carte: BTreeMap<String, Value> = serde_json::from_str(&brut).unwrap_or_default();
    carte.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_owned()))).collect()
}

#[derive(Serialize)]
pub struct Candidat {
    compte: String,
    /// `trousseau`, `fichier-mcp`, ou `reliquat-mcp` (le coffre a déjà ce
    /// secret : seule l'ancienne copie en clair reste à retirer).
    source: &'static str,
}

/// Secrets à importer : les comptes nommés par l'interface (fournisseurs,
/// voix) présents au trousseau, et le contenu de l'ancien `mcp-secrets.json`
/// — y compris les noms que le coffre connaît déjà (reliquat), sans quoi leur
/// copie en clair restait indéfiniment. Aucune valeur.
#[tauri::command]
pub fn coffre_migration_candidats(app: AppHandle, comptes: Vec<String>) -> Result<Vec<Candidat>, String> {
    let d = dossier(&app)?;
    let connus: BTreeSet<String> = avec_coffre(&app, |c| c.liste().map_err(String::from))??
        .into_iter()
        .map(|(n, _, _)| n)
        .collect();
    let mut out = Vec::new();
    for compte in comptes.into_iter().collect::<BTreeSet<_>>() {
        if connus.contains(&compte) || compte.starts_with(PREFIXE_MCP) {
            continue;
        }
        if matches!(trousseau_lire(&compte), Ok(Some(_))) {
            out.push(Candidat { compte, source: "trousseau" });
        }
    }
    // Un scellé du veilleur ne s'importe jamais depuis l'ancien fichier en clair (forgeable).
    for nom in lire_fichier_mcp(&d).into_keys().filter(|n| !est_nom_scelle(n)) {
        let compte = format!("{PREFIXE_MCP}{nom}");
        let source = if connus.contains(&compte) { "reliquat-mcp" } else { "fichier-mcp" };
        out.push(Candidat { compte, source });
    }
    Ok(out)
}

/// Importe les secrets choisis, relit le coffre sur le disque, puis supprime
/// les originaux des seuls secrets relus à l'identique
/// (`coffre_migration::migrer`, testé sans Tauri).
#[tauri::command]
pub fn coffre_migrer(app: AppHandle, choix: Vec<Choix>) -> Result<Bilan, String> {
    if let Some(c) = choix.iter().find(|c| est_nom_scelle(&c.compte)) {
        return Err(format!("« {} » est un scellé du veilleur : il ne s'importe pas", c.compte));
    }
    let d = dossier(&app)?;
    let mut fichier = lire_fichier_mcp(&d);
    let mut index = lire_index(&d);
    let issue = avec_coffre(&app, |c| migrer(c, &mut fichier, &mut index, choix, &TrousseauSysteme))??;
    ecrire_index(&d, &index)?;
    let mut bilan = issue.bilan;
    if issue.fichier_modifie {
        let chemin = d.join(FICHIER_MCP_ANCIEN);
        if fichier.is_empty() {
            bilan.fichier_mcp_supprime = fs::remove_file(&chemin).is_ok();
        } else {
            let contenu = serde_json::to_vec_pretty(&fichier).map_err(|e| e.to_string())?;
            ecrire_atomique(&chemin, &contenu)?;
        }
    }
    for v in fichier.values_mut() {
        v.zeroize();
    }
    journal(
        &app,
        "info",
        "migration vers le coffre",
        json!({ "migres": bilan.migres, "echecs": bilan.echecs.iter().map(|e| &e.compte).collect::<Vec<_>>() }),
    );
    pousser_au_sidecar(&app);
    Ok(bilan)
}

// ---------------------------------------------------------------------------
// Recherche de secrets en clair (§ 9.2)
// ---------------------------------------------------------------------------

/// Longueur minimale d'une valeur cherchée : en dessous, les faux positifs
/// (« 1234 ») noieraient le résultat.
const LONGUEUR_CHERCHEE: usize = 8;
const TAILLE_FICHIER_MAX: u64 = 20 * 1024 * 1024;
const FICHIERS_MAX: usize = 50_000;
const DOSSIERS_IGNORES: [&str; 6] = ["node_modules", ".git", "target", "dist", "dist-dev", "dist-verif"];

/// Fichiers contenant en clair une valeur du coffre. `chemins` : où chercher
/// (récursif). Les fichiers du coffre lui-même sont exclus (chiffrés).
pub fn chercher_en_clair(valeurs: &[String], chemins: &[PathBuf]) -> Vec<String> {
    let aiguilles: Vec<&[u8]> = valeurs.iter().map(|v| v.as_bytes()).filter(|v| !v.is_empty()).collect();
    let mut trouves = Vec::new();
    let mut vus = 0usize;
    let mut pile: Vec<PathBuf> = chemins.to_vec();
    while let Some(p) = pile.pop() {
        let Ok(meta) = fs::symlink_metadata(&p) else { continue };
        if meta.is_dir() {
            let nom = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if DOSSIERS_IGNORES.contains(&nom) {
                continue;
            }
            if let Ok(entrees) = fs::read_dir(&p) {
                pile.extend(entrees.filter_map(|e| e.ok().map(|e| e.path())));
            }
            continue;
        }
        if !meta.is_file() || meta.len() > TAILLE_FICHIER_MAX {
            continue;
        }
        let nom = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if nom.starts_with("coffre.") {
            continue;
        }
        vus += 1;
        if vus > FICHIERS_MAX {
            break;
        }
        let Ok(mut octets) = fs::read(&p) else { continue };
        if aiguilles.iter().any(|a| octets.windows(a.len()).any(|w| w == *a)) {
            trouves.push(p.display().to_string());
        }
        octets.zeroize();
    }
    trouves.sort();
    trouves
}

/// Commande : cherche les valeurs du coffre dans la configuration, les
/// données (état, journaux) et les `projets` donnés. Rend des CHEMINS.
#[tauri::command]
pub fn coffre_chercher_en_clair(app: AppHandle, projets: Vec<String>) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let mut valeurs = avec_coffre(&app, |c| c.valeurs_pour_recherche(LONGUEUR_CHERCHEE).map_err(String::from))??;
    let mut chemins = vec![dossier(&app)?];
    if let Ok(d) = app.path().app_data_dir() {
        chemins.push(d);
    }
    if let Ok(d) = app.path().app_log_dir() {
        chemins.push(d);
    }
    chemins.extend(projets.into_iter().map(PathBuf::from));
    let trouves = chercher_en_clair(&valeurs, &chemins);
    for v in valeurs.iter_mut() {
        v.zeroize();
    }
    journal(&app, if trouves.is_empty() { "info" } else { "warn" }, "recherche de secrets en clair", json!({ "fichiers": trouves }));
    Ok(trouves)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_sans_fenetre_aller_retour_et_absent() {
        let d = std::env::temp_dir().join(format!("iaction-index-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        assert!(lire_index(&d).is_empty(), "absent : vide, sans erreur");
        let noms: BTreeSet<String> = ["mcp:relais.jeton".to_string(), "provider:x".to_string()].into();
        ecrire_index(&d, &noms).unwrap();
        assert_eq!(lire_index(&d), noms);
        fs::write(d.join(FICHIER_INDEX), "pas du json").unwrap();
        assert!(lire_index(&d).is_empty(), "illisible : vide, sans erreur");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn scelles_du_veilleur_jamais_hors_du_coffre_chiffre() {
        assert!(est_nom_scelle("mcp:veilleur.empreinte.abcd1234"));
        assert!(est_nom_scelle("veilleur.empreinte.abcd1234"));
        assert!(est_nom_scelle("mcp:veilleur.empreinte"), "ancienne forme aussi");
        assert!(!est_nom_scelle("mcp:relais.jeton"));
        assert!(!est_nom_scelle("fournisseur:veilleur.empreinte"), "autre préfixe : pas un nom MCP");
        // Reclassement en sans-fenetre refusé pour un scellé, permis sinon.
        assert!(reclassement_refuse("mcp:veilleur.empreinte.abcd1234", Classe::SansFenetre).is_some());
        assert!(reclassement_refuse("mcp:veilleur.empreinte.abcd1234", Classe::Coffre).is_none());
        assert!(reclassement_refuse("mcp:relais.jeton", Classe::SansFenetre).is_none());
        // Un scellé glissé dans l'index n'est jamais lu au trousseau.
        let index: BTreeSet<String> = ["mcp:veilleur.empreinte.abcd1234", "mcp:relais.jeton"].iter().map(|s| s.to_string()).collect();
        assert_eq!(comptes_sans_fenetre_lisibles(&index), vec!["mcp:relais.jeton"]);
    }

    #[test]
    fn ancien_fichier_mcp_ne_garde_que_les_chaines() {
        let d = std::env::temp_dir().join(format!("iaction-mcpanc-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FICHIER_MCP_ANCIEN), r#"{"a":"1","b":2}"#).unwrap();
        let m = lire_fichier_mcp(&d);
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("a").map(String::as_str), Some("1"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn recherche_en_clair_rend_des_chemins() {
        let d = std::env::temp_dir().join(format!("iaction-clair-{}", std::process::id()));
        fs::create_dir_all(d.join("projet/node_modules")).unwrap();
        fs::write(d.join("projet/.env"), "T=valeur-du-coffre-123\n").unwrap();
        fs::write(d.join("projet/node_modules/x.js"), "valeur-du-coffre-123").unwrap();
        fs::write(d.join("projet/ok.txt"), "rien").unwrap();
        fs::write(d.join("coffre.age"), "valeur-du-coffre-123").unwrap();
        let t = chercher_en_clair(&["valeur-du-coffre-123".to_string()], &[d.clone()]);
        assert_eq!(t.len(), 1, "{t:?}");
        assert!(t[0].ends_with(".env"));
        let _ = fs::remove_dir_all(&d);
    }
}
