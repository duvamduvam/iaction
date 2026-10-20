//! Commandes Tauri « périphériques audio » : lister les sorties ET les entrées du système et en
//! choisir la valeur par défaut, depuis le menu du composeur (T-148).
//!
//! POURQUOI côté coquille : la webview ne sait pas changer le périphérique du SYSTÈME (WebKitGTK
//! n'expose pas `setSinkId` de façon fiable, et un `deviceId` web mémorisé primerait sur le
//! défaut système sans qu'on le voie). L'utilisateur veut que son casque Bluetooth reprenne tout
//! le poste, micro compris : on change donc la sortie ET l'entrée par défaut du serveur audio,
//! ce qui est un choix assumé et dit dans l'interface.
//!
//! Linux seulement (`pactl`, qui parle à PulseAudio comme à PipeWire-pulse). Ailleurs, la
//! liste répond « non pris en charge » — un état, pas une erreur — pour que l'UI retombe sur son
//! comportement d'avant (entrées web) ou masque la section.
//!
//! `pactl` est lancé par `Command` avec des arguments séparés, jamais par un shell : le nom reçu
//! de l'UI ne doit pas pouvoir s'interpréter. Il est de plus validé contre la liste relue à
//! l'instant du choix. L'analyse du JSON de `pactl` est une fonction pure, UNE seule pour les
//! deux sens, testée sur des échantillons en dur tirés de la forme réelle (aucun test n'appelle
//! `pactl`).

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::journal_coquille::journal_coquille;

/// Sens d'un périphérique : tout ce qui diffère entre sorties et entrées tient ici, le reste
/// du module est commun.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Sens {
    Sortie,
    Entree,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl Sens {
    /// Objet `pactl` à lister (`list <objet>`).
    fn objet(self) -> &'static str {
        match self {
            Sens::Sortie => "sinks",
            Sens::Entree => "sources",
        }
    }

    fn get_defaut(self) -> &'static str {
        match self {
            Sens::Sortie => "get-default-sink",
            Sens::Entree => "get-default-source",
        }
    }

    fn set_defaut(self) -> &'static str {
        match self {
            Sens::Sortie => "set-default-sink",
            Sens::Entree => "set-default-source",
        }
    }

    fn nom_lisible(self) -> &'static str {
        match self {
            Sens::Sortie => "sortie",
            Sens::Entree => "entrée",
        }
    }
}

/// Un périphérique audio du système (sortie ou entrée).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeripheriqueAudio {
    /// Nom technique du serveur audio (ce que prend `set-default-sink` / `-source`).
    pub nom: String,
    /// Libellé lisible (« Casque … »), repli sur le nom technique s'il est absent.
    pub libelle: String,
    pub par_defaut: bool,
    /// Coupé (`mute`) : c'est la panne d'origine de T-148 — micro interne par défaut ET coupé.
    /// Affichage seul, l'app ne réactive rien.
    pub coupe: bool,
}

/// Réponse de `audio_sorties_lister` / `audio_entrees_lister`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListePeripheriques {
    /// Faux hors Linux : l'UI masque la section (sortie) ou garde les entrées web (micro).
    pub pris_en_charge: bool,
    pub peripheriques: Vec<PeripheriqueAudio>,
}

/// Vrai pour un « moniteur » : la copie de ce qui sort sur une sortie, que `pactl list sources`
/// range parmi les sources. Ce n'est pas un micro. Trois indices, car aucun n'est garanti seul :
/// nom en `.monitor`, `monitor_source` renseigné (vide sur une vraie entrée), `device.class`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn est_moniteur(entree: &Value, nom: &str) -> bool {
    nom.ends_with(".monitor")
        || texte_utile(entree.get("monitor_source")).is_some()
        || entree
            .get("properties")
            .and_then(|p| p.get("device.class"))
            .and_then(Value::as_str)
            == Some("monitor")
}

/// Analyse la sortie de `pactl -f json list sinks|sources`. `defaut` est le nom rendu par
/// `pactl get-default-sink|source` (vide si aucun). Pure : testable sans serveur audio.
///
/// Une entrée sans `name` est ignorée (inutilisable pour `set-default-*`) ; côté entrées, les
/// moniteurs sont écartés. Un JSON qui n'est pas un tableau est une erreur, pas une liste
/// vide — sinon un `pactl` trop ancien (sans `-f json`) passerait pour « aucun périphérique ».
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn analyser_peripheriques_json(
    json_brut: &str,
    defaut: &str,
    sens: Sens,
) -> Result<Vec<PeripheriqueAudio>, String> {
    let valeur: Value = serde_json::from_str(json_brut)
        .map_err(|err| format!("sortie de pactl illisible (JSON invalide : {err})"))?;
    let tableau = valeur
        .as_array()
        .ok_or_else(|| "sortie de pactl inattendue : un tableau de périphériques était attendu".to_string())?;
    let defaut = defaut.trim();
    Ok(tableau
        .iter()
        .filter_map(|entree| {
            let nom = entree.get("name")?.as_str()?.to_string();
            if sens == Sens::Entree && est_moniteur(entree, &nom) {
                return None;
            }
            let libelle = libelle_peripherique(entree, &nom);
            let par_defaut = !defaut.is_empty() && nom == defaut;
            let coupe = entree.get("mute").and_then(Value::as_bool).unwrap_or(false);
            Some(PeripheriqueAudio { nom, libelle, par_defaut, coupe })
        })
        .collect())
}

/// Texte exploitable d'un champ de `pactl` : ni absent, ni vide, ni « (null) ».
///
/// POURQUOI « (null) » : le JSON de `pactl` remplace par cette chaîne toute description qui
/// contient un caractère non ASCII (« Audio interne Stéréo analogique » — constaté le
/// 2026-10-05, trois sorties sur six s'affichaient « (null) » dans le menu). Ce n'est pas un
/// libellé, c'est une valeur manquante.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn texte_utile(valeur: Option<&Value>) -> Option<&str> {
    valeur
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "(null)")
}

/// Libellé lisible d'un périphérique (sortie ou entrée) : la description de `pactl` si elle est exploitable, sinon
/// le nom de l'appareil (`device.description`) suivi du port actif (« Audio interne —
/// Haut-parleurs »), et en dernier recours le nom technique.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn libelle_peripherique(entree: &Value, nom: &str) -> String {
    if let Some(description) = texte_utile(entree.get("description")) {
        return description.to_string();
    }
    let proprietes = entree.get("properties");
    let appareil = ["device.description", "node.nick", "device.product.name"]
        .iter()
        .find_map(|cle| texte_utile(proprietes.and_then(|p| p.get(cle))));
    let port_actif = entree.get("active_port").and_then(Value::as_str);
    let port = entree
        .get("ports")
        .and_then(Value::as_array)
        .and_then(|ports| {
            ports
                .iter()
                .find(|p| p.get("name").and_then(Value::as_str) == port_actif)
        })
        .and_then(|p| texte_utile(p.get("description")));
    match (appareil, port) {
        (Some(a), Some(p)) => format!("{a} — {p}"),
        (Some(a), None) => a.to_string(),
        (None, Some(p)) => p.to_string(),
        (None, None) => nom.to_string(),
    }
}

/// Refuse un nom qui n'est pas dans la liste fraîchement relue. Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn valider_choix(nom: &str, liste: &[PeripheriqueAudio], sens: Sens) -> Result<(), String> {
    if liste.iter().any(|p| p.nom == nom) {
        Ok(())
    } else {
        Err(format!("{} audio inconnue ou disparue : {nom}", sens.nom_lisible()))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::io::ErrorKind;
    use std::process::Command;

    use super::{analyser_peripheriques_json, valider_choix, ListePeripheriques, Sens};

    /// Lance `pactl` avec des arguments séparés. `LC_ALL=C` : les messages d'erreur remontés
    /// ne dépendent pas de la locale ; les libellés, eux, sont reconstruits par
    /// `libelle_peripherique` (le JSON de `pactl` perd les descriptions accentuées, quelle que soit
    /// la locale).
    fn pactl(args: &[&str]) -> Result<String, String> {
        let sortie = Command::new("pactl")
            .args(args)
            .env("LC_ALL", "C")
            .output()
            .map_err(|err| match err.kind() {
                ErrorKind::NotFound => {
                    "`pactl` est introuvable : installez pulseaudio-utils (ou pipewire-pulse)".to_string()
                }
                _ => format!("échec du lancement de pactl : {err}"),
            })?;
        if !sortie.status.success() {
            let erreur = String::from_utf8_lossy(&sortie.stderr);
            return Err(format!("pactl {} a échoué : {}", args.join(" "), erreur.trim()));
        }
        Ok(String::from_utf8_lossy(&sortie.stdout).into_owned())
    }

    pub fn lister(sens: Sens) -> Result<ListePeripheriques, String> {
        let defaut = pactl(&[sens.get_defaut()])?;
        let json_brut = pactl(&["-f", "json", "list", sens.objet()])?;
        Ok(ListePeripheriques {
            pris_en_charge: true,
            peripheriques: analyser_peripheriques_json(&json_brut, &defaut, sens)?,
        })
    }

    pub fn choisir(sens: Sens, nom: &str) -> Result<(), String> {
        // Validation contre la liste relue maintenant : un casque débranché entre
        // l'ouverture du menu et le clic est refusé ici, pas envoyé au serveur audio.
        valider_choix(nom, &lister(sens)?.peripheriques, sens)?;
        pactl(&[sens.set_defaut(), nom]).map(|_| ())
    }
}

#[cfg(not(target_os = "linux"))]
mod linux {
    use super::{ListePeripheriques, Sens};

    pub fn lister(_sens: Sens) -> Result<ListePeripheriques, String> {
        Ok(ListePeripheriques { pris_en_charge: false, peripheriques: Vec::new() })
    }

    pub fn choisir(_sens: Sens, _nom: &str) -> Result<(), String> {
        Err("le choix du périphérique audio n'est pas pris en charge sur ce système".to_string())
    }
}

/// Lecture hors du fil de la boucle d'événements (`pactl` est un process externe).
async fn lister_async(sens: Sens) -> Result<ListePeripheriques, String> {
    tauri::async_runtime::spawn_blocking(move || linux::lister(sens))
        .await
        .map_err(|err| format!("tâche de lecture des périphériques audio interrompue : {err}"))?
}

/// Changement du défaut du système, puis ligne de journal si — et seulement si — il a réussi
/// (les échecs remontent à l'UI, qui les affiche et les journalise).
async fn choisir_async(app: AppHandle, sens: Sens, nom: String) -> Result<(), String> {
    let nom_choisi = nom.clone();
    tauri::async_runtime::spawn_blocking(move || linux::choisir(sens, &nom))
        .await
        .map_err(|err| format!("tâche de changement de périphérique audio interrompue : {err}"))??;
    journal_coquille(
        &app,
        "info",
        &format!("{} audio par défaut du système changée", sens.nom_lisible()),
        &json!({ "nom": nom_choisi }),
    );
    Ok(())
}

/// Commande Tauri : sorties audio du système et laquelle est par défaut. `pris_en_charge` faux
/// hors Linux. Erreur lisible si `pactl` est absent ou échoue.
#[tauri::command]
pub async fn audio_sorties_lister() -> Result<ListePeripheriques, String> {
    lister_async(Sens::Sortie).await
}

/// Commande Tauri : fait de `nom` la sortie par défaut du système (tout le son du poste suit).
/// `nom` est validé contre la liste relue avant exécution.
#[tauri::command]
pub async fn audio_sortie_defaut_choisir(app: AppHandle, nom: String) -> Result<(), String> {
    choisir_async(app, Sens::Sortie, nom).await
}

/// Commande Tauri : entrées audio du système (moniteurs exclus), laquelle est par défaut et
/// lesquelles sont coupées. `pris_en_charge` faux hors Linux.
#[tauri::command]
pub async fn audio_entrees_lister() -> Result<ListePeripheriques, String> {
    lister_async(Sens::Entree).await
}

/// Commande Tauri : fait de `nom` l'entrée par défaut du système. Validé contre la liste relue.
#[tauri::command]
pub async fn audio_entree_defaut_choisir(app: AppHandle, nom: String) -> Result<(), String> {
    choisir_async(app, Sens::Entree, nom).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Échantillon réduit d'un `pactl -f json list sinks`.
    const SORTIES: &str = r#"[
      {"index":0,"state":"SUSPENDED","name":"alsa_output.pci-0000_00_1f.3.analog-stereo",
       "description":"Audio interne Stéréo analogique","mute":false,"properties":{"device.class":"sound"}},
      {"index":5,"state":"RUNNING","name":"bluez_output.AA_BB_CC_DD_EE_FF.1",
       "description":"Casque Bluetooth","mute":false,"properties":{}},
      {"index":7,"state":"IDLE","name":"sans_description","mute":false},
      {"index":8,"state":"IDLE","description":"Sans nom : inutilisable"}
    ]"#;

    /// Échantillon tiré de la forme RÉELLE de `pactl -f json list sources` (2026-10-05, propriétés
    /// élaguées) : « (null) » sur les descriptions accentuées, moniteurs rangés avec les entrées
    /// (nom en `.monitor`, `monitor_source` renseigné, `device.class` « monitor »), micro interne
    /// COUPÉ, casque Bluetooth sans `device.class`.
    const ENTREES: &str = r#"[
      {"index":58,"name":"alsa_output.pci-0000_00_1f.3.analog-stereo.monitor","description":"(null)",
       "mute":false,"monitor_source":"alsa_output.pci-0000_00_1f.3.analog-stereo",
       "properties":{"device.class":"monitor","device.description":"Audio interne"},
       "ports":[{"name":"analog-output-speaker","description":"Haut-parleurs"}],"active_port":"analog-output-speaker"},
      {"index":59,"name":"alsa_input.pci-0000_00_1f.3.analog-stereo","description":"(null)",
       "mute":true,"monitor_source":"",
       "properties":{"device.class":"sound","device.description":"Audio interne"},
       "ports":[{"name":"analog-input-internal-mic","description":"Microphone interne"},
                {"name":"analog-input-mic","description":"Microphone"}],"active_port":"analog-input-internal-mic"},
      {"index":60,"name":"bluez_input.40:9C:A7:5B:66:D6","description":"M50",
       "mute":false,"monitor_source":"","properties":{"device.description":"M50"},
       "ports":[{"name":"headset-input","description":"Mains-libres"}],"active_port":"headset-input"},
      {"index":61,"name":"bluez_output.40:9C:A7:5B:66:D6.monitor","description":"Monitor of M50",
       "mute":false,"monitor_source":"bluez_output.40:9C:A7:5B:66:D6","properties":{"device.class":"monitor"}},
      {"index":62,"name":"source_monitor_sans_suffixe","description":"Moniteur déguisé",
       "mute":false,"monitor_source":"quelque_chose","properties":{}}
    ]"#;

    #[test]
    fn analyse_marque_la_sortie_par_defaut() {
        let l = analyser_peripheriques_json(SORTIES, "bluez_output.AA_BB_CC_DD_EE_FF.1\n", Sens::Sortie).unwrap();
        assert_eq!(l.len(), 3, "l'entrée sans `name` est ignorée");
        assert_eq!(l[1].libelle, "Casque Bluetooth");
        assert!(l[1].par_defaut);
        assert!(!l[0].par_defaut && !l[2].par_defaut);
    }

    #[test]
    fn analyse_replie_le_libelle_sur_le_nom() {
        let l = analyser_peripheriques_json(SORTIES, "", Sens::Sortie).unwrap();
        assert_eq!(l[2].libelle, "sans_description");
        assert!(l.iter().all(|s| !s.par_defaut), "défaut vide : aucune cochée");
    }

    #[test]
    fn analyse_reconstruit_un_libelle_null() {
        // Forme réelle rendue par pactl pour « Audio interne Stéréo analogique ».
        let brut = r#"[
            {"name":"a","description":"(null)","active_port":"hp",
             "properties":{"device.description":"Audio interne"},
             "ports":[{"name":"hp","description":"Haut-parleurs"},{"name":"c","description":"Casque audio"}]},
            {"name":"b","description":"(null)","active_port":"s",
             "properties":{"device.description":"USB Audio"},
             "ports":[{"name":"s","description":"(null)"}]},
            {"name":"c","description":"(null)"}
        ]"#;
        let libelles: Vec<String> = analyser_peripheriques_json(brut, "", Sens::Sortie)
            .unwrap()
            .into_iter()
            .map(|s| s.libelle)
            .collect();
        assert_eq!(libelles, ["Audio interne — Haut-parleurs", "USB Audio", "c"]);
    }

    #[test]
    fn entrees_excluent_les_moniteurs_et_gardent_les_vraies_entrees() {
        let l = analyser_peripheriques_json(ENTREES, "", Sens::Entree).unwrap();
        let noms: Vec<&str> = l.iter().map(|p| p.nom.as_str()).collect();
        assert_eq!(noms, ["alsa_input.pci-0000_00_1f.3.analog-stereo", "bluez_input.40:9C:A7:5B:66:D6"]);
    }

    #[test]
    fn entrees_exposent_l_etat_coupe_et_reconstruisent_le_libelle() {
        let l = analyser_peripheriques_json(ENTREES, "alsa_input.pci-0000_00_1f.3.analog-stereo", Sens::Entree).unwrap();
        assert_eq!(l[0].libelle, "Audio interne — Microphone interne");
        assert!(l[0].coupe && l[0].par_defaut, "la panne d'origine : micro interne par défaut ET coupé");
        assert_eq!(l[1].libelle, "M50");
        assert!(!l[1].coupe && !l[1].par_defaut);
    }

    #[test]
    fn sorties_ne_filtrent_pas_sur_monitor_source() {
        // Un sink porte lui aussi un champ `monitor_source` (le nom de son moniteur) : sans la
        // restriction au sens « entrée », toutes les sorties disparaîtraient.
        let brut = r#"[{"name":"s","description":"S","mute":false,"monitor_source":"s.monitor","properties":{}}]"#;
        assert_eq!(analyser_peripheriques_json(brut, "", Sens::Sortie).unwrap().len(), 1);
    }

    #[test]
    fn analyse_refuse_un_json_qui_n_est_pas_un_tableau() {
        assert!(analyser_peripheriques_json("{}", "", Sens::Sortie).is_err());
        assert!(analyser_peripheriques_json("pas du json", "", Sens::Entree).is_err());
    }

    #[test]
    fn analyse_accepte_une_liste_vide() {
        assert_eq!(analyser_peripheriques_json("[]", "", Sens::Entree).unwrap(), Vec::new());
    }

    #[test]
    fn validation_refuse_un_nom_hors_liste() {
        let l = analyser_peripheriques_json(SORTIES, "", Sens::Sortie).unwrap();
        assert!(valider_choix("bluez_output.AA_BB_CC_DD_EE_FF.1", &l, Sens::Sortie).is_ok());
        assert!(valider_choix("--help", &l, Sens::Sortie).is_err());
        assert!(valider_choix("", &l, Sens::Sortie).is_err());
        // Un moniteur n'est pas un choix valide côté entrées, même s'il existe dans pactl.
        let e = analyser_peripheriques_json(ENTREES, "", Sens::Entree).unwrap();
        assert!(valider_choix("bluez_output.40:9C:A7:5B:66:D6.monitor", &e, Sens::Entree).is_err());
    }
}
