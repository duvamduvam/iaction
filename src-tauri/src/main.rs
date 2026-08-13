// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // PREMIÈRE instruction du programme, et elle doit le rester : c'est
    // l'origine de toutes les mesures de démarrage (voir demarrage.rs). Tout
    // ce qui passerait avant elle sortirait du budget mesuré sans que rien ne
    // le dise.
    iaction_lib::demarrage::marquer_debut();
    iaction_lib::run()
}
