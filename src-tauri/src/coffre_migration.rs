//! Cœur de la migration vers le coffre (docs/etude-coffre-secrets.md § 7),
//! sans Tauri : testable avec un faux trousseau.
//!
//! Ordre imposé (§ 7.3) : tout verser, RELIRE le coffre sur le disque, puis
//! seulement retirer les originaux — et uniquement ceux relus à l'identique.
//! Les commandes Tauri (`coffre_gestion.rs`) lisent et réécrivent l'ancien
//! fichier et l'index autour de cette fonction.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::coffre::{Classe, Coffre, PREFIXE_MCP};

/// Accès au trousseau de l'OS (le vrai, ou un faux en test).
pub trait Trousseau {
    fn lire(&self, compte: &str) -> Result<Option<String>, String>;
    fn poser(&self, compte: &str, valeur: &str) -> Result<(), String>;
    fn retirer(&self, compte: &str);
}

/// Le trousseau du système (crate `keyring`, via `secrets.rs`).
pub struct TrousseauSysteme;

impl Trousseau for TrousseauSysteme {
    fn lire(&self, compte: &str) -> Result<Option<String>, String> {
        crate::secrets::trousseau_lire(compte)
    }
    fn poser(&self, compte: &str, valeur: &str) -> Result<(), String> {
        crate::secrets::trousseau_poser(compte, valeur)
    }
    fn retirer(&self, compte: &str) {
        crate::secrets::trousseau_retirer(compte)
    }
}

#[derive(Deserialize)]
pub struct Choix {
    pub compte: String,
    pub classe: Classe,
}

#[derive(Serialize, Default, Debug)]
pub struct Echec {
    pub compte: String,
    pub cause: String,
}

#[derive(Serialize, Default, Debug)]
pub struct Bilan {
    pub migres: Vec<String>,
    pub echecs: Vec<Echec>,
    #[serde(rename = "fichierMcpSupprime")]
    pub fichier_mcp_supprime: bool,
}

/// Résultat du cœur : le bilan, et l'ancien fichier a-t-il changé ?
pub struct Issue {
    pub bilan: Bilan,
    pub fichier_modifie: bool,
}

/// Verse les secrets choisis, relit, retire les originaux conformes.
///
/// - `fichier` : contenu de l'ancien `mcp-secrets.json` (nom → valeur), modifié
///   en place (entrées migrées retirées) ;
/// - `index` : noms `sans-fenetre`, complété en place.
///
/// Un compte `mcp:<nom>` que le coffre connaît DÉJÀ et que l'ancien fichier
/// porte encore (reliquat) n'est pas réécrit — le coffre fait foi — mais
/// son entrée de fichier est retirée après relecture.
pub fn migrer(
    coffre: &mut Coffre,
    fichier: &mut BTreeMap<String, String>,
    index: &mut BTreeSet<String>,
    choix: Vec<Choix>,
    trousseau: &dyn Trousseau,
) -> Result<Issue, String> {
    let mut bilan = Bilan::default();
    let connus: BTreeSet<String> = coffre.liste().map_err(String::from)?.into_iter().map(|(n, _, _)| n).collect();
    // (compte, classe, venait du fichier)
    let mut poses: Vec<(String, Classe, bool)> = Vec::new();

    for Choix { compte, classe } in choix {
        let nom_fichier = compte.strip_prefix(PREFIXE_MCP).filter(|n| fichier.contains_key(*n)).map(str::to_owned);
        if nom_fichier.is_some() && connus.contains(&compte) {
            // Reliquat : le coffre a déjà ce secret, seule l'ancienne copie part.
            let classe = coffre.classe(&compte).map_err(String::from)?.unwrap_or_default();
            poses.push((compte, classe, true));
            continue;
        }
        let source_fichier = nom_fichier.is_some();
        let valeur = match nom_fichier.and_then(|n| fichier.get(&n).cloned()) {
            Some(v) => Some(v),
            None => match trousseau.lire(&compte) {
                Ok(v) => v,
                Err(e) => {
                    bilan.echecs.push(Echec { compte, cause: e });
                    continue;
                }
            },
        };
        let Some(mut valeur) = valeur else {
            bilan.echecs.push(Echec { compte, cause: "introuvable".into() });
            continue;
        };
        let resultat = match classe {
            Classe::Coffre => coffre.poser(&compte, &valeur, Classe::Coffre).map_err(String::from),
            Classe::SansFenetre => (if source_fichier { trousseau.poser(&compte, &valeur) } else { Ok(()) })
                .and_then(|_| coffre.poser(&compte, "", Classe::SansFenetre).map_err(String::from))
                .map(|_| {
                    index.insert(compte.clone());
                }),
        };
        valeur.zeroize();
        match resultat {
            Ok(()) => poses.push((compte, classe, source_fichier)),
            Err(cause) => bilan.echecs.push(Echec { compte, cause }),
        }
    }

    let noms: Vec<String> = poses.iter().map(|(n, _, _)| n.clone()).collect();
    let non_conformes: BTreeSet<String> = if noms.is_empty() {
        BTreeSet::new()
    } else {
        coffre.relecture_non_conformes(&noms).map_err(String::from)?.into_iter().collect()
    };

    // Originaux retirés APRÈS la relecture, et seulement pour les conformes.
    let mut fichier_modifie = false;
    for (compte, classe, source_fichier) in poses {
        if non_conformes.contains(&compte) {
            bilan.echecs.push(Echec { compte, cause: "relecture du coffre non conforme : original conservé".into() });
            continue;
        }
        if source_fichier {
            if let Some(mut v) = compte.strip_prefix(PREFIXE_MCP).and_then(|n| fichier.remove(n)) {
                v.zeroize();
                fichier_modifie = true;
            }
        } else if classe == Classe::Coffre {
            trousseau.retirer(&compte);
        }
        bilan.migres.push(compte);
    }
    Ok(Issue { bilan, fichier_modifie })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FauxTrousseau {
        valeurs: RefCell<BTreeMap<String, String>>,
    }

    impl Trousseau for FauxTrousseau {
        fn lire(&self, compte: &str) -> Result<Option<String>, String> {
            Ok(self.valeurs.borrow().get(compte).cloned())
        }
        fn poser(&self, compte: &str, valeur: &str) -> Result<(), String> {
            self.valeurs.borrow_mut().insert(compte.into(), valeur.into());
            Ok(())
        }
        fn retirer(&self, compte: &str) {
            self.valeurs.borrow_mut().remove(compte);
        }
    }

    fn coffre_ouvert(nom: &str) -> (Coffre, std::path::PathBuf) {
        let d = std::env::temp_dir().join(format!("iaction-migr-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let mut c = Coffre::pour_tests(d.clone());
        c.creer("mot-de-passe-test").unwrap();
        (c, d)
    }

    #[test]
    fn originaux_retires_apres_relecture_seulement_pour_les_conformes() {
        let (mut c, d) = coffre_ouvert("ok");
        let t = FauxTrousseau::default();
        t.poser("provider:a", "cle-a").unwrap();
        t.poser("provider:b", "cle-b").unwrap();
        let mut fichier: BTreeMap<String, String> = [("relais.jeton".to_string(), "jeton-r".to_string())].into();
        let mut index = BTreeSet::new();
        let choix = vec![
            Choix { compte: "provider:a".into(), classe: Classe::Coffre },
            Choix { compte: "provider:b".into(), classe: Classe::SansFenetre },
            Choix { compte: "mcp:relais.jeton".into(), classe: Classe::Coffre },
            Choix { compte: "provider:absent".into(), classe: Classe::Coffre },
        ];
        let issue = migrer(&mut c, &mut fichier, &mut index, choix, &t).unwrap();
        assert_eq!(issue.bilan.migres, vec!["provider:a", "provider:b", "mcp:relais.jeton"]);
        assert_eq!(issue.bilan.echecs.len(), 1, "le compte absent échoue seul");
        assert!(issue.fichier_modifie && fichier.is_empty(), "entrée de l'ancien fichier retirée");
        assert_eq!(t.lire("provider:a").unwrap(), None, "copie au trousseau d'un `coffre` retirée");
        assert_eq!(t.lire("provider:b").unwrap().as_deref(), Some("cle-b"), "un sans-fenêtre reste au trousseau");
        assert!(index.contains("provider:b"));
        assert_eq!(c.lire("mcp:relais.jeton").unwrap().as_deref(), Some("jeton-r"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ecriture_impossible_garde_les_originaux() {
        let (mut c, d) = coffre_ouvert("ko");
        let t = FauxTrousseau::default();
        t.poser("provider:a", "cle-a").unwrap();
        let mut fichier: BTreeMap<String, String> = [("x".to_string(), "vx".to_string())].into();
        // Le dossier du coffre devient un FICHIER : toute écriture échoue.
        std::fs::remove_dir_all(&d).unwrap();
        std::fs::write(&d, "pas un dossier").unwrap();
        let choix = vec![
            Choix { compte: "provider:a".into(), classe: Classe::Coffre },
            Choix { compte: "mcp:x".into(), classe: Classe::Coffre },
        ];
        let issue = migrer(&mut c, &mut fichier, &mut BTreeSet::new(), choix, &t).unwrap();
        assert!(issue.bilan.migres.is_empty());
        assert_eq!(issue.bilan.echecs.len(), 2);
        assert_eq!(t.lire("provider:a").unwrap().as_deref(), Some("cle-a"), "original conservé");
        assert_eq!(fichier.get("x").map(String::as_str), Some("vx"), "ancien fichier intact");
        assert!(!issue.fichier_modifie);
        let _ = std::fs::remove_file(&d);
    }

    #[test]
    fn reliquat_de_l_ancien_fichier_retire_sans_ecraser_le_coffre() {
        let (mut c, d) = coffre_ouvert("reliquat");
        c.poser("mcp:relais.jeton", "valeur-du-coffre", Classe::Coffre).unwrap();
        let mut fichier: BTreeMap<String, String> = [("relais.jeton".to_string(), "ancienne".to_string())].into();
        let choix = vec![Choix { compte: "mcp:relais.jeton".into(), classe: Classe::Coffre }];
        let issue = migrer(&mut c, &mut fichier, &mut BTreeSet::new(), choix, &FauxTrousseau::default()).unwrap();
        assert_eq!(issue.bilan.migres, vec!["mcp:relais.jeton"]);
        assert!(fichier.is_empty(), "reliquat retiré du fichier");
        assert_eq!(c.lire("mcp:relais.jeton").unwrap().as_deref(), Some("valeur-du-coffre"), "le coffre fait foi");
        let _ = std::fs::remove_dir_all(&d);
    }
}
