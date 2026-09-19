//! Le registre des fenêtres — une seule fenêtre par projet, un seul processus,
//! un seul sidecar (T-062).
//!
//! Décision utilisateur du 2026-08-15 (`docs/etude-deux-projets.md` §7) : deux
//! projets ouverts en même temps, chacun dans sa fenêtre, mais JAMAIS deux
//! fenêtres sur le même projet — ouvrir un projet déjà ouvert BASCULE sur sa
//! fenêtre, comme un éditeur le fait pour un fichier. Ce module tient la table
//! `projet → étiquette de fenêtre` qui rend cette règle vérifiable, et les
//! commandes qui la câblent à Tauri : ouverture d'une fenêtre, revendication
//! d'un projet, libération à la fermeture, état pour l'affichage.
//!
//! La table elle-même (`Registre`) est une structure PURE, sans dépendance à
//! Tauri : patron du dépôt (voir `state_store.rs`) — la logique en feuille
//! testable, la plomberie Tauri autour.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::sidecar;
use crate::webview_vie;

/// Taille par défaut d'une fenêtre secondaire — identique à `main`
/// (`tauri.conf.json`), pour ne pas surprendre avec une fenêtre d'une taille
/// différente sur le second écran. Volontairement NON maximisée : le besoin
/// réel est de la poser à côté, pas de la faire déborder du premier écran.
const LARGEUR_DEFAUT: f64 = 1280.0;
const HAUTEUR_DEFAUT: f64 = 800.0;

/// Table pure `projet → étiquette de fenêtre`.
#[derive(Default)]
pub struct Registre {
    projets: HashMap<String, String>,
}

impl Registre {
    /// Tente d'attribuer `projet` à `fenetre`. `vivante(etiquette)` répond si
    /// une fenêtre portant cette étiquette existe encore — sans ce contrôle,
    /// une entrée périmée (fenêtre fermée sans passer par `liberer`, crash…)
    /// interdirait l'ouverture du projet POUR TOUJOURS, ce qu'aucune panne
    /// transitoire ne justifie.
    ///
    /// `None` = revendication acceptée, `projet` est maintenant à `fenetre`.
    /// `Some(etiquette)` = une AUTRE fenêtre, encore vivante, le porte déjà —
    /// c'est à l'appelant de basculer dessus au lieu d'ouvrir localement.
    pub fn revendiquer(
        &mut self,
        fenetre: &str,
        projet: &str,
        vivante: impl Fn(&str) -> bool,
    ) -> Option<String> {
        if let Some(porteuse) = self.projets.get(projet) {
            if porteuse == fenetre {
                // Idempotent : la fenêtre re-revendique ce qu'elle porte déjà.
                return None;
            }
            if vivante(porteuse) {
                return Some(porteuse.clone());
            }
            // Entrée périmée : la fenêtre qui portait ce projet n'existe plus
            // — le projet est libre malgré l'entrée encore en table, qu'on va
            // écraser juste en dessous.
        }
        // Une fenêtre ne porte qu'UN projet à la fois : revendiquer un second
        // libère implicitement le premier.
        self.projets.retain(|_, f| f != fenetre);
        self.projets.insert(projet.to_string(), fenetre.to_string());
        None
    }

    /// Retire toutes les entrées portées par `fenetre` — et aucune autre.
    /// Appelé à la fermeture d'une fenêtre.
    pub fn liberer(&mut self, fenetre: &str) {
        self.projets.retain(|_, f| f != fenetre);
    }

    /// Copie de la table, pour `fenetres_projets_ouverts`.
    fn projets_ouverts(&self) -> HashMap<String, String> {
        self.projets.clone()
    }
}

/// État géré par Tauri (`.manage()`) : le registre, plus le compteur
/// d'étiquettes des fenêtres créées dynamiquement.
pub struct EtatFenetres {
    registre: Registre,
    /// Prochain suffixe à distribuer (`main-2`, `main-3`…). Ne redescend
    /// JAMAIS : une étiquette fermée n'est pas réutilisée, pour qu'une
    /// commande arrivant en retard sur une fenêtre fermée ne puisse jamais
    /// viser une fenêtre différente rouverte depuis sous la même étiquette.
    prochain_suffixe: u32,
}

impl Default for EtatFenetres {
    fn default() -> Self {
        Self {
            registre: Registre::default(),
            // `main` existe déjà (déclarée dans `tauri.conf.json`) : la
            // première fenêtre créée dynamiquement est donc `main-2`.
            prochain_suffixe: 2,
        }
    }
}

impl EtatFenetres {
    fn nouvelle_etiquette(&mut self) -> String {
        let etiquette = format!("main-{}", self.prochain_suffixe);
        self.prochain_suffixe += 1;
        etiquette
    }
}

/// Type de l'état managé par Tauri (`app.manage(...)` / `State<'_, SharedFenetres>`).
pub type SharedFenetres = Mutex<EtatFenetres>;

/// Construit la valeur à passer à `Builder::manage`.
pub fn managed_state() -> SharedFenetres {
    Mutex::new(EtatFenetres::default())
}

/// Verrouille l'état partagé, en récupérant la donnée même si le mutex a été
/// empoisonné par un panic précédent (comme `sidecar.rs` : on ne veut jamais
/// paniquer sur un chemin d'exécution normal).
fn lock_state(mutex: &SharedFenetres) -> MutexGuard<'_, EtatFenetres> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Commande Tauri : ouvre une nouvelle fenêtre (`main-2`, `main-3`…) sur la
/// même page que `main` — même application, seule la fenêtre change (décision
/// utilisateur du 2026-08-15). Renvoie l'étiquette créée.
#[tauri::command]
pub fn fenetre_ouvrir(app: AppHandle) -> Result<String, String> {
    let shared = app.state::<SharedFenetres>();
    let etiquette = lock_state(&shared).nouvelle_etiquette();

    let fenetre = WebviewWindowBuilder::new(&app, &etiquette, WebviewUrl::App("index.html".into()))
        .title("IAction")
        .inner_size(LARGEUR_DEFAUT, HAUTEUR_DEFAUT)
        .center()
        .build()
        .map_err(|err| {
            let msg = format!("échec de l'ouverture de la fenêtre {etiquette} : {err}");
            sidecar::log_app(
                &app,
                "error",
                msg.clone(),
                serde_json::json!({ "etiquette": etiquette }),
            );
            msg
        })?;

    // Même câblage que la fenêtre principale (T-062, blocant 7) : sans ça, la
    // nouvelle fenêtre serait vivante mais sourde au micro, et la mort de son
    // process de contenu (T-030) passerait sans une ligne de journal.
    #[cfg(target_os = "linux")]
    crate::autoriser_micro_webkit(&fenetre);
    #[cfg(target_os = "linux")]
    webview_vie::surveiller(&fenetre);

    sidecar::log_app(
        &app,
        "info",
        "nouvelle fenêtre ouverte".to_string(),
        serde_json::json!({ "etiquette": etiquette }),
    );
    Ok(etiquette)
}

/// Commande Tauri : tente d'attribuer `projet` à `fenetre`. Si une AUTRE
/// fenêtre, vivante, le porte déjà, elle est ramenée au premier plan
/// (démaximisation + focus, best-effort — un échec est journalisé, jamais
/// propagé, l'utilisateur peut toujours cliquer dessus lui-même) et son
/// étiquette est renvoyée : c'est à l'appelant de basculer dessus au lieu
/// d'ouvrir le projet localement.
#[tauri::command]
pub fn fenetre_projet_revendiquer(
    app: AppHandle,
    fenetre: String,
    projet: String,
) -> Result<Option<String>, String> {
    let vivantes = app.webview_windows();
    let shared = app.state::<SharedFenetres>();
    let resultat = lock_state(&shared)
        .registre
        .revendiquer(&fenetre, &projet, |etiquette| vivantes.contains_key(etiquette));

    match &resultat {
        None => sidecar::log_app(
            &app,
            "info",
            "projet attribué à la fenêtre".to_string(),
            serde_json::json!({ "fenetre": fenetre, "projet": projet }),
        ),
        Some(porteuse) => {
            sidecar::log_app(
                &app,
                "info",
                "projet déjà porté par une autre fenêtre : bascule".to_string(),
                serde_json::json!({
                    "fenetre_demandeuse": fenetre,
                    "projet": projet,
                    "fenetre_porteuse": porteuse,
                }),
            );
            if let Some(fenetre_porteuse) = vivantes.get(porteuse) {
                if let Err(err) = fenetre_porteuse.unminimize() {
                    sidecar::log_app(
                        &app,
                        "warn",
                        "échec de la sortie de réduction de la fenêtre porteuse".to_string(),
                        serde_json::json!({ "fenetre": porteuse, "erreur": err.to_string() }),
                    );
                }
                if let Err(err) = fenetre_porteuse.set_focus() {
                    sidecar::log_app(
                        &app,
                        "warn",
                        "échec du focus de la fenêtre porteuse".to_string(),
                        serde_json::json!({ "fenetre": porteuse, "erreur": err.to_string() }),
                    );
                }
            }
        }
    }
    Ok(resultat)
}

/// Commande Tauri : retire toutes les entrées portées par `fenetre` du
/// registre. Appelée à la fermeture d'une fenêtre — voir `lib.rs`,
/// `on_window_event`.
#[tauri::command]
pub fn fenetre_projet_liberer(app: AppHandle, fenetre: String) {
    let shared = app.state::<SharedFenetres>();
    lock_state(&shared).registre.liberer(&fenetre);
    sidecar::log_app(
        &app,
        "info",
        "registre de fenêtres libéré".to_string(),
        serde_json::json!({ "fenetre": fenetre }),
    );
}

/// Commande Tauri : état courant du registre, `projet → étiquette`.
#[tauri::command]
pub fn fenetres_projets_ouverts(app: AppHandle) -> HashMap<String, String> {
    let shared = app.state::<SharedFenetres>();
    let projets = lock_state(&shared).registre.projets_ouverts();
    projets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revendiquer_un_projet_libre_l_attribue() {
        let mut registre = Registre::default();
        let resultat = registre.revendiquer("main", "projet-a", |_| false);
        assert_eq!(resultat, None);
        assert_eq!(registre.projets_ouverts().get("projet-a"), Some(&"main".to_string()));
    }

    #[test]
    fn re_revendiquer_son_propre_projet_est_idempotent() {
        let mut registre = Registre::default();
        registre.revendiquer("main", "projet-a", |_| true);
        let resultat = registre.revendiquer("main", "projet-a", |_| true);
        assert_eq!(resultat, None);
        assert_eq!(registre.projets_ouverts().len(), 1);
    }

    #[test]
    fn une_fenetre_ne_porte_qu_un_projet_a_la_fois() {
        let mut registre = Registre::default();
        registre.revendiquer("main", "projet-a", |_| true);
        registre.revendiquer("main", "projet-b", |_| true);

        let projets = registre.projets_ouverts();
        assert_eq!(projets.get("projet-a"), None, "le premier projet doit être libéré");
        assert_eq!(projets.get("projet-b"), Some(&"main".to_string()));
    }

    #[test]
    fn un_projet_porte_par_une_fenetre_vivante_refuse_la_revendication() {
        let mut registre = Registre::default();
        registre.revendiquer("main", "projet-a", |_| true);

        let resultat = registre.revendiquer("main-2", "projet-a", |_| true);
        assert_eq!(resultat, Some("main".to_string()));
        // La table n'a pas bougé : le refus ne doit rien modifier.
        assert_eq!(registre.projets_ouverts().get("projet-a"), Some(&"main".to_string()));
    }

    #[test]
    fn un_projet_porte_par_une_fenetre_morte_est_considere_libre() {
        let mut registre = Registre::default();
        registre.revendiquer("main", "projet-a", |_| true);

        // "main" n'est plus vivante (fermée sans passer par `liberer`, ou
        // crash) : la revendication doit réussir malgré l'entrée périmée.
        let resultat = registre.revendiquer("main-2", "projet-a", |_| false);
        assert_eq!(resultat, None);
        assert_eq!(registre.projets_ouverts().get("projet-a"), Some(&"main-2".to_string()));
    }

    #[test]
    fn liberer_retire_uniquement_les_entrees_de_cette_fenetre() {
        let mut registre = Registre::default();
        registre.revendiquer("main", "projet-a", |_| true);
        registre.revendiquer("main-2", "projet-b", |_| true);

        registre.liberer("main");

        let projets = registre.projets_ouverts();
        assert_eq!(projets.get("projet-a"), None);
        assert_eq!(projets.get("projet-b"), Some(&"main-2".to_string()));
    }

    #[test]
    fn les_etiquettes_sont_croissantes_et_jamais_reutilisees() {
        let mut etat = EtatFenetres::default();
        assert_eq!(etat.nouvelle_etiquette(), "main-2");
        assert_eq!(etat.nouvelle_etiquette(), "main-3");
        assert_eq!(etat.nouvelle_etiquette(), "main-4");
    }
}
