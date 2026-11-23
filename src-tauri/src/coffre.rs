//! Coffre de secrets chiffré, déverrouillé par mot de passe (docs/etude-coffre-secrets.md).
//!
//! Ce module est le CŒUR, sans Tauri : fichiers, chiffrement, table en mémoire,
//! tentatives. La colle Tauri (commandes, poussée au sidecar, verrouillage
//! automatique) vit dans `coffre_commandes.rs`. Séparés pour que tout ce qui
//! touche à la cryptographie se teste sans application.
//!
//! ## Deux fichiers, parce que `age` l'exige (§ 4.1)
//!
//! `age` interdit de mêler une phrase de passe et un autre destinataire dans
//! un même fichier. D'où deux niveaux :
//!
//! - `coffre.age` : la table des secrets, chiffrée pour une identité X25519
//!   tirée au hasard à la création ;
//! - `coffre.cle.age` : cette identité, chiffrée par le mot de passe (scrypt).
//!
//! Changer de mot de passe ne réécrit que `coffre.cle.age`. L'identité EST la
//! clé de secours : elle ouvre `coffre.age` sans mot de passe, y compris hors
//! d'IAction (`age -d -i cle.txt coffre.age`).
//!
//! ## Contrat non négociable
//!
//! Aucune valeur de secret ne sort de ce module autrement que par
//! [`Coffre::lire`] et [`Coffre::table_mcp`], appelés par la coquille pour un
//! usage précis. Les messages d'erreur ne citent que des NOMS. Les valeurs en
//! mémoire sont effacées (`zeroize`) à la fermeture du coffre.

use std::collections::BTreeMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

use age::secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// Table chiffrée des secrets.
pub const FICHIER_COFFRE: &str = "coffre.age";
/// Identité X25519 chiffrée par le mot de passe.
pub const FICHIER_CLE: &str = "coffre.cle.age";
/// Version précédente de la table : une écriture interrompue ne coûte jamais tout.
pub const FICHIER_PRECEDENT: &str = "coffre.age.prec";

/// Longueur minimale d'un mot de passe. Le coffre protège contre la lecture
/// passive d'une copie du disque : un mot de passe court se casse hors ligne.
pub const MOT_DE_PASSE_MIN: usize = 8;

/// Échecs tolérés avant que le délai croissant ne s'applique (§ 4.3).
const ECHECS_SANS_DELAI: u32 = 3;
/// Plafond du délai entre deux essais.
const DELAI_MAX: Duration = Duration::from_secs(300);

/// Préfixe des secrets MCP dans la table : `mcp:<nom>` ↔ `${SECRET:<nom>}`.
pub const PREFIXE_MCP: &str = "mcp:";

/// Classe d'un secret (§ 5). `SansFenetre` reste au trousseau de l'OS, lisible
/// par les tâches de fond ; le coffre n'en garde que la classe (valeur vide).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Classe {
    #[default]
    #[serde(rename = "coffre")]
    Coffre,
    #[serde(rename = "sans-fenetre")]
    SansFenetre,
}

/// Une entrée de la table.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entree {
    /// Valeur du secret. Vide pour un secret `sans-fenetre` (valeur au trousseau).
    pub valeur: String,
    /// Date de création (AAAA-MM-JJ).
    pub cree: String,
    #[serde(default)]
    pub classe: Classe,
}

/// Contenu déchiffré de `coffre.age`.
#[derive(Serialize, Deserialize, Debug, Default)]
struct Table {
    version: u32,
    secrets: BTreeMap<String, Entree>,
}

impl Drop for Table {
    /// Efface les valeurs en mémoire. Les `String` libérées sans cela
    /// laisseraient les jetons dans le tas jusqu'à réutilisation de la page.
    fn drop(&mut self) {
        for entree in self.secrets.values_mut() {
            entree.valeur.zeroize();
        }
    }
}

/// Coffre ouvert : l'identité et la table, en mémoire seulement.
struct Ouvert {
    identite: age::x25519::Identity,
    table: Table,
    /// Ouvert par la clé de secours : le changement de mot de passe ne
    /// demande alors pas l'ancien (on l'a, par hypothèse, oublié).
    par_secours: bool,
}

/// État visible du coffre.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Etat {
    /// Aucun coffre créé sur ce poste.
    Absent,
    Verrouille,
    Ouvert,
}

/// Erreur d'une opération du coffre. Le message ne contient JAMAIS de valeur.
#[derive(Debug, PartialEq, Eq)]
pub enum Erreur {
    Absent,
    DejaCree,
    Verrouille,
    MotDePasseIncorrect,
    MotDePasseTropCourt,
    CleDeSecoursInvalide,
    /// Trop d'échecs : nouvel essai possible dans ce délai (secondes).
    Patienter(u64),
    /// Fichier illisible, disque, chiffrement : message lisible, sans valeur.
    Technique(String),
}

impl std::fmt::Display for Erreur {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Erreur::Absent => write!(f, "aucun coffre n'existe sur ce poste"),
            Erreur::DejaCree => write!(f, "un coffre existe déjà sur ce poste"),
            Erreur::Verrouille => write!(f, "coffre verrouillé : déverrouille-le d'abord"),
            Erreur::MotDePasseIncorrect => write!(f, "mot de passe incorrect"),
            Erreur::MotDePasseTropCourt => write!(
                f,
                "mot de passe trop court : {MOT_DE_PASSE_MIN} caractères au moins"
            ),
            Erreur::CleDeSecoursInvalide => write!(f, "clé de secours invalide pour ce coffre"),
            Erreur::Patienter(s) => write!(f, "trop d'essais : nouvel essai possible dans {s} s"),
            Erreur::Technique(m) => write!(f, "{m}"),
        }
    }
}

impl From<Erreur> for String {
    fn from(e: Erreur) -> String {
        e.to_string()
    }
}

/// Le coffre d'un poste.
pub struct Coffre {
    dossier: PathBuf,
    ouvert: Option<Ouvert>,
    echecs: u32,
    prochain_essai: Option<Instant>,
    /// Facteur de travail scrypt (log2 N) imposé. `None` = calibrage de `age`
    /// (environ une seconde). Seuls les tests le baissent.
    facteur_scrypt: Option<u8>,
    /// Ouvert sur `coffre.age.prec` parce que `coffre.age` était illisible :
    /// la dernière écriture est perdue. Tant que c'est vrai, `coffre.age.prec`
    /// n'est pas écrasé par le fichier abîmé. Remis à faux à la première
    /// écriture réussie.
    repli_precedent: bool,
}

impl Coffre {
    pub fn nouveau(dossier: PathBuf) -> Self {
        Self { dossier, ouvert: None, echecs: 0, prochain_essai: None, facteur_scrypt: None, repli_precedent: false }
    }

    #[cfg(test)]
    pub(crate) fn pour_tests(dossier: PathBuf) -> Self {
        Self { facteur_scrypt: Some(10), ..Self::nouveau(dossier) }
    }

    fn chemin(&self, nom: &str) -> PathBuf {
        self.dossier.join(nom)
    }

    /// Le coffre ouvert vient-il de sa version précédente (voir le champ) ?
    pub fn repli_precedent(&self) -> bool {
        self.repli_precedent
    }

    pub fn etat(&self) -> Etat {
        if self.ouvert.is_some() {
            Etat::Ouvert
        } else if self.chemin(FICHIER_CLE).exists() {
            Etat::Verrouille
        } else {
            Etat::Absent
        }
    }

    // -----------------------------------------------------------------------
    // Création, ouverture, fermeture
    // -----------------------------------------------------------------------

    /// Crée le coffre et l'ouvre. Renvoie la clé de secours (`AGE-SECRET-KEY-1…`),
    /// à montrer UNE fois : elle n'est conservée nulle part en clair.
    pub fn creer(&mut self, mot_de_passe: &str) -> Result<SecretString, Erreur> {
        if self.chemin(FICHIER_CLE).exists() || self.chemin(FICHIER_COFFRE).exists() {
            return Err(Erreur::DejaCree);
        }
        verifier_longueur(mot_de_passe)?;
        fs::create_dir_all(&self.dossier).map_err(|e| technique("création du dossier", e))?;

        let identite = age::x25519::Identity::generate();
        let secours = identite.to_string();
        self.ecrire_cle(&identite, mot_de_passe)?;
        let ouvert = Ouvert {
            identite,
            table: Table { version: 1, secrets: BTreeMap::new() },
            par_secours: false,
        };
        ecrire_table(&self.dossier, &ouvert, false)?;
        self.ouvert = Some(ouvert);
        self.echecs = 0;
        self.prochain_essai = None;
        Ok(secours)
    }

    /// Ouvre le coffre par le mot de passe.
    pub fn deverrouiller(&mut self, mot_de_passe: &str) -> Result<(), Erreur> {
        self.controler_delai()?;
        let chiffre = self.lire_fichier(FICHIER_CLE)?;
        let mut id_mdp = age::scrypt::Identity::new(SecretString::from(mot_de_passe.to_owned()));
        if let Some(f) = self.facteur_scrypt {
            id_mdp.set_max_work_factor(f);
        }
        let identite = match age::decrypt(&id_mdp, &chiffre) {
            Ok(mut clair) => {
                let texte = String::from_utf8_lossy(&clair).into_owned();
                clair.zeroize();
                let resultat = lire_identite(&texte);
                let mut texte = texte;
                texte.zeroize();
                resultat.ok_or_else(|| Erreur::Technique("fichier de clé du coffre illisible".into()))?
            }
            Err(e) => return Err(self.erreur_cle(e)),
        };
        self.ouvrir_avec(identite, false)
    }

    /// Traduit un échec de déchiffrement de `coffre.cle.age`. Seul un mot de
    /// passe faux (`DecryptionFailed`) compte comme un essai raté : un fichier
    /// abîmé ou d'un format inconnu ne doit pas s'afficher « mot de passe
    /// incorrect » — on chercherait en vain le bon mot de passe.
    fn erreur_cle(&mut self, e: age::DecryptError) -> Erreur {
        match e {
            age::DecryptError::DecryptionFailed => self.noter_echec(),
            // Le fichier est déjà lu en mémoire : une erreur d'E/S ici vient de
            // son contenu (en-tête tronqué), pas du disque.
            age::DecryptError::ExcessiveWork { .. } => Erreur::Technique(
                "clé du coffre chiffrée avec un facteur de travail trop élevé pour ce poste : ouvre-le par la clé de secours".into(),
            ),
            autre => Erreur::Technique(format!(
                "fichier de clé du coffre abîmé ({autre}) : ouvre le coffre par la clé de secours"
            )),
        }
    }

    /// Ouvre le coffre par la clé de secours (identité `AGE-SECRET-KEY-1…`).
    pub fn deverrouiller_secours(&mut self, cle: &str) -> Result<(), Erreur> {
        self.controler_delai()?;
        let Some(identite) = lire_identite(cle) else {
            return Err(self.noter_echec_secours());
        };
        match self.ouvrir_avec(identite, true) {
            Err(Erreur::CleDeSecoursInvalide) => Err(self.noter_echec_secours()),
            autre => autre,
        }
    }

    /// Ouvre le coffre par son identité X25519, lue au trousseau du système
    /// (déverrouillage automatique, coffre_auto.rs — T-225). Une identité
    /// illisible ou étrangère à ce coffre est une erreur qui ne change pas
    /// l'état et ne compte PAS comme un essai raté : ce n'est pas une saisie,
    /// c'est une entrée de trousseau périmée.
    pub fn deverrouiller_par_identite(&mut self, identite: &str) -> Result<(), Erreur> {
        let Some(identite) = lire_identite(identite) else {
            return Err(Erreur::Technique("clé du déverrouillage automatique illisible".into()));
        };
        // Table absente sans version précédente : `ouvrir_avec` réécrirait une
        // table vide sous CETTE identité, sans vérifier qu'elle est celle de
        // `coffre.cle.age`. Acceptable au mot de passe (l'identité en sort),
        // pas pour une entrée de trousseau qui peut dater d'un autre coffre.
        if !self.chemin(FICHIER_COFFRE).exists() && !self.chemin(FICHIER_PRECEDENT).exists() {
            return Err(Erreur::Technique(
                "table du coffre absente : ouvre le coffre par le mot de passe".into(),
            ));
        }
        match self.ouvrir_avec(identite, false) {
            Err(Erreur::CleDeSecoursInvalide) => Err(Erreur::Technique(
                "clé du déverrouillage automatique sans rapport avec ce coffre".into(),
            )),
            autre => autre,
        }
    }

    /// Identité du coffre ouvert (`AGE-SECRET-KEY-1…`), pour la ranger au
    /// trousseau (déverrouillage automatique). Jamais journalisée.
    pub fn identite_courante(&self) -> Result<SecretString, Erreur> {
        self.ouvert.as_ref().map(|o| o.identite.to_string()).ok_or(Erreur::Verrouille)
    }

    /// Ferme le coffre : la table et l'identité quittent la mémoire (effacées).
    pub fn verrouiller(&mut self) {
        self.ouvert = None;
        self.repli_precedent = false;
    }

    /// Change le mot de passe. L'ancien est exigé, sauf si le coffre a été
    /// ouvert par la clé de secours. Ne réécrit que `coffre.cle.age`.
    pub fn changer_mot_de_passe(&mut self, ancien: Option<&str>, nouveau: &str) -> Result<(), Erreur> {
        verifier_longueur(nouveau)?;
        let par_secours = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?.par_secours;
        if !par_secours {
            // Vérifier l'ancien sur le fichier, pas seulement « le coffre est
            // ouvert » : quelqu'un devant un poste resté ouvert ne doit pas
            // pouvoir changer le mot de passe à l'insu de son propriétaire.
            // Même délai d'essais que l'ouverture : sinon ce chemin servait
            // d'oracle pour deviner le mot de passe sur un poste resté ouvert.
            self.controler_delai()?;
            let ancien = ancien.ok_or(Erreur::MotDePasseIncorrect)?;
            let chiffre = self.lire_fichier(FICHIER_CLE)?;
            let mut id_mdp = age::scrypt::Identity::new(SecretString::from(ancien.to_owned()));
            if let Some(f) = self.facteur_scrypt {
                id_mdp.set_max_work_factor(f);
            }
            if let Err(e) = age::decrypt(&id_mdp, &chiffre).map(|mut c| c.zeroize()) {
                return Err(self.erreur_cle(e));
            }
            self.echecs = 0;
            self.prochain_essai = None;
        }
        let identite = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?.identite.clone();
        self.ecrire_cle(&identite, nouveau)?;
        if let Some(o) = self.ouvert.as_mut() {
            o.par_secours = false;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Secrets
    // -----------------------------------------------------------------------

    /// Valeur d'un secret de classe `coffre` (`None` si absent ou `sans-fenetre`).
    pub fn lire(&self, nom: &str) -> Result<Option<String>, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        Ok(o.table
            .secrets
            .get(nom)
            .filter(|e| e.classe == Classe::Coffre)
            .map(|e| e.valeur.clone()))
    }

    /// Classe d'un secret connu du coffre.
    pub fn classe(&self, nom: &str) -> Result<Option<Classe>, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        Ok(o.table.secrets.get(nom).map(|e| e.classe))
    }

    /// Pose ou remplace un secret, puis réécrit le coffre. Pour la classe
    /// `sans-fenetre`, la valeur n'est PAS gardée (elle va au trousseau,
    /// c'est l'appelant qui l'y met) : seule la classe est retenue.
    pub fn poser(&mut self, nom: &str, valeur: &str, classe: Classe) -> Result<(), Erreur> {
        let dossier = self.dossier.clone();
        let o = self.ouvert.as_mut().ok_or(Erreur::Verrouille)?;
        let cree = o
            .table
            .secrets
            .get(nom)
            .map(|e| e.cree.clone())
            .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
        let valeur = if classe == Classe::Coffre { valeur.to_owned() } else { String::new() };
        if let Some(mut ancienne) = o.table.secrets.insert(nom.to_owned(), Entree { valeur, cree, classe }) {
            ancienne.valeur.zeroize();
        }
        let r = ecrire_table(&dossier, o, !self.repli_precedent);
        if r.is_ok() {
            self.repli_precedent = false;
        }
        r
    }

    /// Retire un secret. Renvoie `true` s'il existait.
    pub fn retirer(&mut self, nom: &str) -> Result<bool, Erreur> {
        let dossier = self.dossier.clone();
        let o = self.ouvert.as_mut().ok_or(Erreur::Verrouille)?;
        match o.table.secrets.remove(nom) {
            Some(mut e) => {
                e.valeur.zeroize();
                ecrire_table(&dossier, o, !self.repli_precedent)?;
                self.repli_precedent = false;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Noms des secrets (jamais les valeurs), avec leur classe et leur date
    /// de création : l'écran des secrets.
    pub fn liste(&self) -> Result<Vec<(String, Classe, String)>, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        Ok(o.table.secrets.iter().map(|(k, e)| (k.clone(), e.classe, e.cree.clone())).collect())
    }

    /// Valeurs de classe `coffre` d'au moins `min` caractères — pour la seule
    /// recherche de copies en clair (§ 9.2, `coffre_gestion`), qui ne rend que
    /// des chemins. Effacées par l'appelant après usage.
    pub fn valeurs_pour_recherche(&self, min: usize) -> Result<Vec<String>, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        Ok(o.table
            .secrets
            .values()
            .filter(|e| e.classe == Classe::Coffre && e.valeur.chars().count() >= min)
            .map(|e| e.valeur.clone())
            .collect())
    }

    /// Relit `coffre.age` SUR LE DISQUE et le compare à la table en mémoire
    /// pour `noms` : renvoie les noms non conformes (absents ou différents).
    /// Garde-fou de la migration (§ 7.3) : les originaux ne sont supprimés
    /// qu'après une relecture réussie. Aucune valeur ne sort.
    pub fn relecture_non_conformes(&self, noms: &[String]) -> Result<Vec<String>, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        let disque = self.dechiffrer_table(FICHIER_COFFRE, &o.identite)?;
        Ok(noms
            .iter()
            .filter(|n| match (o.table.secrets.get(*n), disque.secrets.get(*n)) {
                (Some(m), Some(d)) => m.valeur != d.valeur || m.classe != d.classe,
                _ => true,
            })
            .cloned()
            .collect())
    }

    /// Le coffre SUR LE DISQUE dit-il la même chose que la mémoire pour `nom` ?
    /// Absent des deux côtés = conforme (un retrait relu). Aucune valeur ne sort.
    pub fn disque_conforme(&self, nom: &str) -> Result<bool, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        let disque = self.dechiffrer_table(FICHIER_COFFRE, &o.identite)?;
        Ok(match (o.table.secrets.get(nom), disque.secrets.get(nom)) {
            (None, None) => true,
            (Some(m), Some(d)) => m.valeur == d.valeur && m.classe == d.classe,
            _ => false,
        })
    }

    /// Table des secrets MCP de classe `coffre`, sous leur nom `${SECRET:…}`
    /// (préfixe `mcp:` retiré) : ce que la coquille pousse au sidecar.
    pub fn table_mcp(&self) -> Result<BTreeMap<String, String>, Erreur> {
        let o = self.ouvert.as_ref().ok_or(Erreur::Verrouille)?;
        Ok(o.table
            .secrets
            .iter()
            .filter(|(_, e)| e.classe == Classe::Coffre)
            .filter_map(|(k, e)| k.strip_prefix(PREFIXE_MCP).map(|n| (n.to_owned(), e.valeur.clone())))
            .collect())
    }

    // -----------------------------------------------------------------------
    // Interne
    // -----------------------------------------------------------------------

    fn lire_fichier(&self, nom: &str) -> Result<Vec<u8>, Erreur> {
        match fs::read(self.chemin(nom)) {
            Ok(b) => Ok(b),
            Err(e) if e.kind() == ErrorKind::NotFound && nom == FICHIER_CLE => Err(Erreur::Absent),
            Err(e) => Err(technique(&format!("lecture de {nom}"), e)),
        }
    }

    fn ecrire_cle(&self, identite: &age::x25519::Identity, mot_de_passe: &str) -> Result<(), Erreur> {
        let mut dest = age::scrypt::Recipient::new(SecretString::from(mot_de_passe.to_owned()));
        if let Some(f) = self.facteur_scrypt {
            dest.set_work_factor(f);
        }
        // Format d'un fichier d'identité `age` : déchiffré à la main
        // (`age -d coffre.cle.age`), il s'utilise tel quel avec `age -d -i`.
        let mut clair = format!(
            "# Clé du coffre IAction — ouvre coffre.age (age -d -i <ce fichier> coffre.age)\n{}\n",
            identite.to_string().expose_secret()
        );
        let chiffre = age::encrypt(&dest, clair.as_bytes());
        clair.zeroize();
        let chiffre = chiffre.map_err(|e| Erreur::Technique(format!("chiffrement de la clé : {e}")))?;
        ecrire_atomique(&self.dossier, FICHIER_CLE, &chiffre, false)
    }

    /// Déchiffre la table avec `identite` ; repli sur `coffre.age.prec` si la
    /// version courante est illisible (écriture interrompue).
    fn ouvrir_avec(&mut self, identite: age::x25519::Identity, par_secours: bool) -> Result<(), Erreur> {
        let precedent = self.chemin(FICHIER_PRECEDENT).exists();
        // Clé présente, table absente, sans version précédente : la création a
        // été interrompue entre les deux fichiers. Coffre vide, réécrit tout de
        // suite — sinon ni l'ouverture ni `creer` (`DejaCree`) n'aboutissaient.
        if !self.chemin(FICHIER_COFFRE).exists() && !precedent {
            let ouvert = Ouvert { identite, table: Table { version: 1, secrets: BTreeMap::new() }, par_secours };
            ecrire_table(&self.dossier, &ouvert, false)?;
            self.ouvert = Some(ouvert);
            self.echecs = 0;
            self.prochain_essai = None;
            self.repli_precedent = false;
            return Ok(());
        }
        let (table, repli) = match self.dechiffrer_table(FICHIER_COFFRE, &identite) {
            Ok(t) => (t, false),
            Err(Erreur::CleDeSecoursInvalide) if !precedent => return Err(Erreur::CleDeSecoursInvalide),
            Err(_) if precedent => (self.dechiffrer_table(FICHIER_PRECEDENT, &identite)?, true),
            Err(e) => return Err(e),
        };
        self.ouvert = Some(Ouvert { identite, table, par_secours });
        self.echecs = 0;
        self.prochain_essai = None;
        self.repli_precedent = repli;
        Ok(())
    }

    fn dechiffrer_table(&self, nom: &str, identite: &age::x25519::Identity) -> Result<Table, Erreur> {
        let chiffre = match fs::read(self.chemin(nom)) {
            Ok(b) => b,
            // Clé présente mais table absente : coffre vide (création interrompue).
            Err(e) if e.kind() == ErrorKind::NotFound && nom == FICHIER_COFFRE => {
                return Err(Erreur::Technique("table du coffre absente".into()));
            }
            Err(e) => return Err(technique(&format!("lecture de {nom}"), e)),
        };
        let mut clair = match age::decrypt(identite, &chiffre) {
            Ok(c) => c,
            Err(age::DecryptError::NoMatchingKeys) => return Err(Erreur::CleDeSecoursInvalide),
            Err(e) => return Err(Erreur::Technique(format!("{nom} illisible : {e}"))),
        };
        let table = serde_json::from_slice::<Table>(&clair);
        clair.zeroize();
        table.map_err(|_| Erreur::Technique(format!("{nom} : contenu invalide")))
    }

    fn controler_delai(&self) -> Result<(), Erreur> {
        if let Some(t) = self.prochain_essai {
            let maintenant = Instant::now();
            if maintenant < t {
                return Err(Erreur::Patienter((t - maintenant).as_secs().max(1)));
            }
        }
        Ok(())
    }

    fn noter_echec(&mut self) -> Erreur {
        self.echecs += 1;
        if self.echecs >= ECHECS_SANS_DELAI {
            self.prochain_essai = Some(Instant::now() + delai_apres(self.echecs));
        }
        Erreur::MotDePasseIncorrect
    }

    fn noter_echec_secours(&mut self) -> Erreur {
        let _ = self.noter_echec();
        Erreur::CleDeSecoursInvalide
    }

    #[cfg(test)]
    fn lever_delai(&mut self) {
        self.prochain_essai = None;
    }
}

/// Délai imposé après `echecs` échecs consécutifs : 1 s au 3e, puis doublé,
/// plafonné. Gardé en mémoire seulement (un redémarrage le remet à zéro) : le
/// scrypt d'une seconde par essai reste le vrai frein à une attaque en ligne.
fn delai_apres(echecs: u32) -> Duration {
    let rang = echecs.saturating_sub(ECHECS_SANS_DELAI).min(16);
    Duration::from_secs(1u64 << rang).min(DELAI_MAX)
}

fn verifier_longueur(mot_de_passe: &str) -> Result<(), Erreur> {
    if mot_de_passe.chars().count() < MOT_DE_PASSE_MIN {
        return Err(Erreur::MotDePasseTropCourt);
    }
    Ok(())
}

/// Lit une identité `AGE-SECRET-KEY-1…` dans un texte (lignes `#` ignorées).
fn lire_identite(texte: &str) -> Option<age::x25519::Identity> {
    texte
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .and_then(|l| age::x25519::Identity::from_str(l).ok())
}

fn technique(quoi: &str, e: std::io::Error) -> Erreur {
    Erreur::Technique(format!("échec de la {quoi} : {e}"))
}

/// Chiffre et écrit la table : copie de la version courante en `.prec`, puis
/// fichier temporaire synchronisé et renommé par-dessus.
/// `garder_precedent` : copier la version courante en `.prec` avant de la
/// remplacer — à FAUX quand la version courante est celle qui est abîmée
/// (ouverture en repli), pour ne pas écraser la seule bonne copie.
fn ecrire_table(dossier: &Path, ouvert: &Ouvert, garder_precedent: bool) -> Result<(), Erreur> {
    let mut clair = serde_json::to_vec(&ouvert.table)
        .map_err(|e| Erreur::Technique(format!("sérialisation du coffre : {e}")))?;
    let chiffre = age::encrypt(&ouvert.identite.to_public(), &clair);
    clair.zeroize();
    let chiffre = chiffre.map_err(|e| Erreur::Technique(format!("chiffrement du coffre : {e}")))?;
    ecrire_atomique(dossier, FICHIER_COFFRE, &chiffre, garder_precedent)
}

fn ecrire_atomique(dossier: &Path, nom: &str, contenu: &[u8], garder_precedent: bool) -> Result<(), Erreur> {
    let cible = dossier.join(nom);
    if garder_precedent && cible.exists() {
        fs::copy(&cible, dossier.join(FICHIER_PRECEDENT)).map_err(|e| technique("copie de sauvegarde du coffre", e))?;
    }
    let tmp = dossier.join(format!("{nom}.tmp-{}", std::process::id()));
    let ecrire = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contenu)?;
        f.sync_all()
    };
    if let Err(e) = ecrire() {
        let _ = fs::remove_file(&tmp);
        return Err(technique(&format!("écriture de {nom}"), e));
    }
    restreindre_droits(&tmp);
    fs::rename(&tmp, &cible).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        technique(&format!("remplacement de {nom}"), e)
    })
}

/// 0600 sous Unix. Le contenu est chiffré : c'est une précaution, pas la protection.
#[cfg(unix)]
fn restreindre_droits(chemin: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(chemin, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restreindre_droits(_chemin: &Path) {}

#[cfg(test)]
#[path = "coffre/tests.rs"]
mod tests;
