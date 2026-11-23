//! Fermeture automatique du coffre à la mise en veille et au verrouillage de
//! session (docs/etude-coffre-secrets.md § 4.3 et § 10).
//!
//! Tauri n'expose ni l'un ni l'autre : on les écoute nous-mêmes.
//!
//! - **Linux** : signaux de logind sur le bus système — `PrepareForSleep(true)`
//!   AVANT la veille, `Lock` et la propriété `LockedHint` de la session pour
//!   l'écran de verrouillage (GNOME, KDE et la plupart des verrouilleurs
//!   passent par logind).
//! - **Windows** : `OpenInputDesktop` échoue tant que le bureau sécurisé
//!   (Win+L) est affiché ; sondé toutes les 3 s, confirmé sur deux sondes
//!   pour ne pas fermer sur une invite UAC brève. La veille est constatée
//!   AU RÉVEIL (saut d'horloge) : limite assumée, voir plus bas.
//!
//! Chaque détection passe par `fermeture_auto`, qui appelle
//! `coffre_commandes::demander_fermeture` (attente de la fin des tours en
//! cours) — sauf si le déverrouillage automatique est actif sur ce poste
//! (coffre_auto.rs, T-225) : fermer ne protégerait rien, le trousseau
//! rouvrirait le coffre. Un écouteur qui ne peut pas démarrer le dit dans le
//! journal : jamais d'échec muet.

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::json;
use tauri::AppHandle;

use crate::coffre::Etat;
use crate::coffre_commandes::{demander_fermeture, journal};

pub const CAUSE_VEILLE: &str = "mise en veille";
pub const CAUSE_SESSION: &str = "verrouillage de session";

/// Saut d'horloge au-delà duquel on conclut que la machine a dormi.
const SAUT_VEILLE: Duration = Duration::from_secs(60);
const PAS_SONDE: Duration = Duration::from_secs(3);

/// Un même verrouillage arrive par plusieurs signaux (`Lock` puis
/// `LockedHint` sous logind) : une fermeture ignorée ne se dit qu'une fois
/// par cause dans cette fenêtre.
const FENETRE_AVIS: Duration = Duration::from_secs(30);

static DERNIER_AVIS: Mutex<Option<(&'static str, Instant)>> = Mutex::new(None);

/// Fermeture automatique, ou son abandon motivé si le déverrouillage
/// automatique est actif. Trousseau illisible : on ferme, par prudence.
fn fermeture_auto(app: &AppHandle, cause: &'static str) {
    if crate::coffre_commandes::etat(app) != Etat::Ouvert {
        return;
    }
    match crate::coffre_auto::actif_ici() {
        Ok(false) => demander_fermeture(app, cause),
        Ok(true) => {
            if premier_avis(cause, Instant::now()) {
                journal(
                    app,
                    "info",
                    "coffre laissé ouvert : déverrouillage automatique actif sur ce poste",
                    json!({ "cause": cause }),
                );
            }
        }
        Err(e) => {
            journal(
                app,
                "warn",
                "déverrouillage automatique : trousseau illisible, coffre fermé par prudence",
                json!({ "cause": cause, "erreur": e }),
            );
            demander_fermeture(app, cause);
        }
    }
}

fn premier_avis(cause: &'static str, maintenant: Instant) -> bool {
    let mut dernier = match DERNIER_AVIS.lock() {
        Ok(g) => g,
        Err(empoisonne) => empoisonne.into_inner(),
    };
    let deja = matches!(*dernier, Some((c, t)) if c == cause && maintenant.duration_since(t) < FENETRE_AVIS);
    if !deja {
        *dernier = Some((cause, maintenant));
    }
    !deja
}

/// Démarre les écouteurs de la plateforme.
pub fn demarrer(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let a = app.clone();
        thread::spawn(move || {
            if let Err(err) = linux::ecouter(&a) {
                crate::sidecar::log_app(
                    &a,
                    "warn",
                    "fermeture automatique du coffre indisponible (logind)".to_string(),
                    json!({ "erreur": err }),
                );
                // Repli : au moins la veille, constatée au réveil.
                sonder_saut_horloge(&a);
            }
        });
    }
    #[cfg(windows)]
    {
        let a = app.clone();
        thread::spawn(move || windows::sonder(&a));
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let a = app.clone();
        crate::sidecar::log_app(
            app,
            "info",
            "verrouillage de session non surveillé sur cette plateforme : veille constatée au réveil".to_string(),
            json!({}),
        );
        thread::spawn(move || sonder_saut_horloge(&a));
    }
}

/// Une veille se voit au réveil : l'horloge murale a sauté bien plus loin
/// que le pas de sonde. Ferme alors le coffre (après les tours en cours).
#[allow(dead_code)]
fn sonder_saut_horloge(app: &AppHandle) {
    let mut avant = SystemTime::now();
    loop {
        thread::sleep(PAS_SONDE);
        let maintenant = SystemTime::now();
        if est_saut_de_veille(avant, maintenant) {
            fermeture_auto(app, CAUSE_VEILLE);
        }
        avant = maintenant;
    }
}

fn est_saut_de_veille(avant: SystemTime, maintenant: SystemTime) -> bool {
    maintenant
        .duration_since(avant)
        .map(|d| d > SAUT_VEILLE)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use dbus::arg::{prop_cast, PropMap};
    use dbus::blocking::stdintf::org_freedesktop_dbus::PropertiesPropertiesChanged;
    use dbus::blocking::Connection;
    use dbus::message::{MatchRule, SignalArgs};
    use tauri::AppHandle;

    use super::{fermeture_auto, CAUSE_SESSION, CAUSE_VEILLE};

    const LOGIND: &str = "org.freedesktop.login1";

    pub fn ecouter(app: &AppHandle) -> Result<(), String> {
        let conn = Connection::new_system().map_err(|e| format!("bus système : {e}"))?;
        let proxy = conn.with_proxy(LOGIND, "/org/freedesktop/login1", Duration::from_secs(5));

        let a = app.clone();
        conn.add_match(
            MatchRule::new_signal("org.freedesktop.login1.Manager", "PrepareForSleep"),
            move |(avant,): (bool,), _, _| {
                if avant {
                    fermeture_auto(&a, CAUSE_VEILLE);
                }
                true
            },
        )
        .map_err(|e| format!("abonnement PrepareForSleep : {e}"))?;

        // Session de l'application. `GetSessionByPID` d'abord (IAction lancée
        // depuis le bureau est dans la session) ; « auto » en repli.
        let session: Result<(dbus::Path<'static>,), _> =
            proxy.method_call("org.freedesktop.login1.Manager", "GetSessionByPID", (std::process::id(),));
        let session = match session {
            Ok(s) => Ok(s),
            Err(_) => proxy.method_call("org.freedesktop.login1.Manager", "GetSession", ("auto",)),
        };
        match session {
            Ok((chemin,)) => {
                let a = app.clone();
                conn.add_match(
                    MatchRule::new_signal("org.freedesktop.login1.Session", "Lock").with_path(chemin.clone()),
                    move |(): (), _, _| {
                        fermeture_auto(&a, CAUSE_SESSION);
                        true
                    },
                )
                .map_err(|e| format!("abonnement Lock : {e}"))?;
                let a = app.clone();
                conn.add_match(
                    PropertiesPropertiesChanged::match_rule(None, Some(&chemin)).static_clone(),
                    move |pc: PropertiesPropertiesChanged, _, _| {
                        if verrouille(&pc.changed_properties) {
                            fermeture_auto(&a, CAUSE_SESSION);
                        }
                        true
                    },
                )
                .map_err(|e| format!("abonnement LockedHint : {e}"))?;
            }
            Err(e) => {
                // La veille reste couverte ; le verrouillage d'écran non. Dit, pas tu.
                crate::sidecar::log_app(
                    app,
                    "warn",
                    "session logind introuvable : le coffre ne se fermera pas au verrouillage d'écran".to_string(),
                    serde_json::json!({ "erreur": e.to_string() }),
                );
            }
        }

        loop {
            conn.process(Duration::from_secs(60)).map_err(|e| format!("bus système : {e}"))?;
        }
    }

    fn verrouille(proprietes: &PropMap) -> bool {
        prop_cast::<bool>(proprietes, "LockedHint").copied().unwrap_or(false)
    }
}

#[cfg(windows)]
mod windows {
    use std::thread;
    use std::time::SystemTime;

    use tauri::AppHandle;
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_SWITCHDESKTOP};

    use super::{est_saut_de_veille, fermeture_auto, CAUSE_SESSION, CAUSE_VEILLE, PAS_SONDE};

    /// Vrai quand le bureau d'entrée n'est pas accessible (écran verrouillé).
    fn ecran_verrouille() -> bool {
        // SAFETY : appels Win32 sans pointeur fourni ; le handle obtenu est
        // refermé aussitôt.
        unsafe {
            let bureau = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if bureau.is_null() {
                return true;
            }
            CloseDesktop(bureau);
            false
        }
    }

    pub fn sonder(app: &AppHandle) {
        let mut avant = SystemTime::now();
        let mut sondes_verrouillees = 0u32;
        loop {
            thread::sleep(PAS_SONDE);
            let maintenant = SystemTime::now();
            if est_saut_de_veille(avant, maintenant) {
                fermeture_auto(app, CAUSE_VEILLE);
            }
            avant = maintenant;
            if ecran_verrouille() {
                sondes_verrouillees += 1;
                if sondes_verrouillees == 2 {
                    fermeture_auto(app, CAUSE_SESSION);
                }
            } else {
                sondes_verrouillees = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saut_d_horloge() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!est_saut_de_veille(t0, t0 + Duration::from_secs(3)));
        assert!(est_saut_de_veille(t0, t0 + Duration::from_secs(600)));
        // Horloge reculée (réglage NTP) : pas une veille.
        assert!(!est_saut_de_veille(t0, t0 - Duration::from_secs(600)));
    }

    #[test]
    fn fermeture_ignoree_dite_une_fois_par_evenement() {
        let t0 = Instant::now();
        assert!(premier_avis(CAUSE_SESSION, t0));
        assert!(!premier_avis(CAUSE_SESSION, t0 + Duration::from_secs(1)), "Lock puis LockedHint : un seul avis");
        assert!(premier_avis(CAUSE_VEILLE, t0 + Duration::from_secs(2)), "autre cause : nouvel avis");
        assert!(premier_avis(CAUSE_VEILLE, t0 + Duration::from_secs(2) + FENETRE_AVIS), "fenêtre passée : nouvel avis");
    }
}
