/*!
Tests unitaires de `sidecar.rs`.

Sortis du module principal parce que le cliquet de taille refusait — à juste
titre — de le voir grossir encore : il vit sous dérogation datée depuis le
2026-08-13 (T-034), et son découpage est dû. Les tests étaient la coupe la plus
franche : aucune logique ne les lie au reste du fichier, seulement `super`.
*/

mod tests_commande {
    use crate::reseau::Reseau;
    use crate::sidecar::commande_sidecar;

    fn args(cmd: std::process::Command) -> Vec<String> {
        cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// Le drapeau proxy doit être là, et AVANT le script : Node ne traite ses
    /// propres options qu'avant le nom du fichier à exécuter — placé après, il
    /// serait passé au sidecar comme un argument quelconque et ignoré en
    /// silence. Panne d'entreprise garantie, sans un mot dans le journal.
    #[test]
    fn le_sidecar_est_lance_avec_le_proxy_de_lenvironnement() {
        let cmd = commande_sidecar("/chemin/node", "/chemin/index.js", &Reseau::default());
        assert_eq!(args(cmd), vec!["--use-env-proxy", "/chemin/index.js"]);
    }

    /// T-045 — même règle de position pour `--use-system-ca`, et surtout : sans
    /// réglage réseau, la ligne de commande ne bouge pas d'un octet.
    #[test]
    fn le_ca_systeme_sajoute_avant_le_script_et_seulement_sil_est_demande() {
        let cmd = commande_sidecar(
            "/chemin/node",
            "/chemin/index.js",
            &Reseau { ca_systeme: true, ..Reseau::default() },
        );
        let a = args(cmd);
        assert!(a.contains(&"--use-system-ca".to_string()), "drapeau absent : {a:?}");
        assert_eq!(a.last().map(String::as_str), Some("/chemin/index.js"), "options avant le script");
    }

    /// Les variables saisies dans l'application atteignent l'enfant — c'est
    /// tout l'objet de T-045, `--use-env-proxy` ne lisant que l'environnement.
    #[test]
    fn les_variables_reseau_sont_posees_sur_lenfant() {
        let cmd = commande_sidecar(
            "/chemin/node",
            "/chemin/index.js",
            &Reseau { proxy: Some("http://proxy:3128".into()), ..Reseau::default() },
        );
        let posees: Vec<_> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        assert!(posees.iter().any(|(k, v)| k == "HTTPS_PROXY" && v == "http://proxy:3128"), "{posees:?}");
    }
}

mod tests_chemins {
    use crate::sidecar::sans_prefixe_verbatim;
    use std::path::Path;

    #[test]
    fn retire_le_prefixe_verbatim_dun_disque() {
        assert_eq!(
            sans_prefixe_verbatim(Path::new(r"\\?\C:\Users\x\IAction\sidecar\index.js")),
            r"C:\Users\x\IAction\sidecar\index.js",
        );
    }

    #[test]
    fn retablit_la_forme_unc_dun_partage() {
        assert_eq!(
            sans_prefixe_verbatim(Path::new(r"\\?\UNC\serveur\partage\app\index.js")),
            r"\\serveur\partage\app\index.js",
        );
    }

    #[test]
    fn laisse_intact_un_chemin_ordinaire() {
        assert_eq!(sans_prefixe_verbatim(Path::new("/usr/lib/IAction/sidecar/index.js")), "/usr/lib/IAction/sidecar/index.js");
        assert_eq!(sans_prefixe_verbatim(Path::new(r"C:\deja\simple.js")), r"C:\deja\simple.js");
    }
}
