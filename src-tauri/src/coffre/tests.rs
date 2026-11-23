//! Tests du coffre (docs/etude-coffre-secrets.md § 9.1). Facteur scrypt réduit
//! (`pour_tests`) : le chiffrement est le même, seul le coût du calcul baisse.

use super::*;

struct Dossier(PathBuf);

impl Dossier {
    fn nouveau(etiquette: &str) -> Self {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let d = std::env::temp_dir().join(format!("iaction-coffre-{etiquette}-{}-{n}", std::process::id()));
        fs::create_dir_all(&d).expect("dossier de test");
        Dossier(d)
    }
}

impl Drop for Dossier {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const MDP: &str = "correct-horse-battery";
const VALEUR: &str = "sk-valeur-tres-secrete-0123456789";

fn coffre_cree(d: &Dossier) -> (Coffre, String) {
    let mut c = Coffre::pour_tests(d.0.clone());
    let secours = c.creer(MDP).expect("création");
    (c, secours.expose_secret().to_owned())
}

#[test]
fn ecrit_puis_relu_a_l_identique() {
    let d = Dossier::nouveau("relu");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:openrouter", VALEUR, Classe::Coffre).unwrap();
    c.poser("mcp:relais.token", "jeton-relais", Classe::Coffre).unwrap();
    c.verrouiller();
    assert_eq!(c.etat(), Etat::Verrouille);
    assert_eq!(c.lire("provider:openrouter"), Err(Erreur::Verrouille));

    let mut c2 = Coffre::pour_tests(d.0.clone());
    c2.deverrouiller(MDP).expect("ouverture");
    assert_eq!(c2.lire("provider:openrouter").unwrap().as_deref(), Some(VALEUR));
    let mcp = c2.table_mcp().unwrap();
    assert_eq!(mcp.get("relais.token").map(String::as_str), Some("jeton-relais"));
    assert!(!mcp.contains_key("provider:openrouter"), "seuls les secrets mcp: partent au sidecar");
}

#[test]
fn aucune_valeur_en_clair_sur_le_disque() {
    let d = Dossier::nouveau("clair");
    let (mut c, secours) = coffre_cree(&d);
    c.poser("provider:x", VALEUR, Classe::Coffre).unwrap();
    c.poser("provider:x", "autre-valeur-secrete", Classe::Coffre).unwrap();
    for f in fs::read_dir(&d.0).unwrap() {
        let octets = fs::read(f.unwrap().path()).unwrap();
        let texte = String::from_utf8_lossy(&octets);
        assert!(!texte.contains(VALEUR) && !texte.contains("autre-valeur-secrete"));
        assert!(!texte.contains(&secours), "la clé de secours ne doit être nulle part en clair");
    }
}

#[test]
fn mauvais_mot_de_passe_refuse_puis_delai_croissant() {
    let d = Dossier::nouveau("mdp");
    let (mut c, _) = coffre_cree(&d);
    c.verrouiller();
    for _ in 0..2 {
        assert_eq!(c.deverrouiller("pas-le-bon-mdp"), Err(Erreur::MotDePasseIncorrect));
    }
    // Troisième échec : le délai s'arme.
    assert_eq!(c.deverrouiller("pas-le-bon-mdp"), Err(Erreur::MotDePasseIncorrect));
    assert!(matches!(c.deverrouiller(MDP), Err(Erreur::Patienter(_))), "même le bon mot de passe attend");
    c.lever_delai();
    c.deverrouiller(MDP).expect("le bon mot de passe ouvre après le délai");
    assert_eq!(c.echecs, 0, "un succès remet le compteur à zéro");
    assert_eq!(delai_apres(3), Duration::from_secs(1));
    assert_eq!(delai_apres(5), Duration::from_secs(4));
    assert_eq!(delai_apres(40), DELAI_MAX);
}

#[test]
fn ecriture_interrompue_sans_perte() {
    let d = Dossier::nouveau("interrompue");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:a", "valeur-a", Classe::Coffre).unwrap();
    c.poser("provider:b", "valeur-b", Classe::Coffre).unwrap();
    c.verrouiller();
    // Simule une écriture coupée net : table courante tronquée, temporaire orphelin.
    let courant = d.0.join(FICHIER_COFFRE);
    let octets = fs::read(&courant).unwrap();
    fs::write(&courant, &octets[..octets.len() / 2]).unwrap();
    fs::write(d.0.join(format!("{FICHIER_COFFRE}.tmp-999")), b"debris").unwrap();

    let mut c2 = Coffre::pour_tests(d.0.clone());
    c2.deverrouiller(MDP).expect("ouverture sur la version précédente");
    // La version précédente porte tout sauf la toute dernière écriture.
    assert_eq!(c2.lire("provider:a").unwrap().as_deref(), Some("valeur-a"));
}

#[test]
fn changement_de_mot_de_passe() {
    let d = Dossier::nouveau("changement");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:a", VALEUR, Classe::Coffre).unwrap();
    let table_avant = fs::read(d.0.join(FICHIER_COFFRE)).unwrap();
    assert_eq!(
        c.changer_mot_de_passe(Some("mauvais-ancien"), "nouveau-mot-de-passe"),
        Err(Erreur::MotDePasseIncorrect)
    );
    assert_eq!(c.changer_mot_de_passe(Some(MDP), "court"), Err(Erreur::MotDePasseTropCourt));
    c.changer_mot_de_passe(Some(MDP), "nouveau-mot-de-passe").unwrap();
    assert_eq!(fs::read(d.0.join(FICHIER_COFFRE)).unwrap(), table_avant, "seule la clé est réécrite");
    c.verrouiller();
    assert_eq!(c.deverrouiller(MDP), Err(Erreur::MotDePasseIncorrect));
    c.deverrouiller("nouveau-mot-de-passe").unwrap();
    assert_eq!(c.lire("provider:a").unwrap().as_deref(), Some(VALEUR));
}

#[test]
fn ouverture_par_la_cle_de_secours() {
    let d = Dossier::nouveau("secours");
    let (mut c, secours) = coffre_cree(&d);
    assert!(secours.starts_with("AGE-SECRET-KEY-1"));
    c.poser("provider:a", VALEUR, Classe::Coffre).unwrap();
    c.verrouiller();

    let mut c2 = Coffre::pour_tests(d.0.clone());
    let autre = age::x25519::Identity::generate().to_string();
    assert_eq!(c2.deverrouiller_secours(autre.expose_secret()), Err(Erreur::CleDeSecoursInvalide));
    assert_eq!(c2.deverrouiller_secours("n'importe quoi"), Err(Erreur::CleDeSecoursInvalide));
    c2.deverrouiller_secours(&secours).expect("la clé de secours ouvre");
    assert_eq!(c2.lire("provider:a").unwrap().as_deref(), Some(VALEUR));
    // Ouvert par secours : nouveau mot de passe sans l'ancien.
    c2.changer_mot_de_passe(None, "mot-de-passe-retrouve").unwrap();
    c2.verrouiller();
    c2.deverrouiller("mot-de-passe-retrouve").unwrap();
}

#[test]
fn coffre_dechiffrable_hors_iaction_par_age() {
    // Le contrat de récupération : `coffre.cle.age` déchiffré à la main donne
    // un fichier d'identité `age` standard, qui ouvre `coffre.age`.
    let d = Dossier::nouveau("hors-iaction");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:a", VALEUR, Classe::Coffre).unwrap();
    let mut id_mdp = age::scrypt::Identity::new(SecretString::from(MDP.to_owned()));
    id_mdp.set_max_work_factor(10);
    let cle = age::decrypt(&id_mdp, &fs::read(d.0.join(FICHIER_CLE)).unwrap()).unwrap();
    let fichier_identite = age::IdentityFile::from_buffer(&cle[..]).unwrap();
    let identites = fichier_identite.into_identities().unwrap();
    let chiffre = fs::read(d.0.join(FICHIER_COFFRE)).unwrap();
    let dechiffreur = age::Decryptor::new(&chiffre[..]).unwrap();
    let mut lecteur = dechiffreur.decrypt(identites.iter().map(|i| i.as_ref())).unwrap();
    let mut clair = Vec::new();
    std::io::Read::read_to_end(&mut lecteur, &mut clair).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&clair).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["secrets"]["provider:a"]["valeur"], VALEUR);
    assert_eq!(json["secrets"]["provider:a"]["classe"], "coffre");
}

#[test]
fn creation_refusee_si_existe_ou_mot_de_passe_court() {
    let d = Dossier::nouveau("creation");
    let mut c = Coffre::pour_tests(d.0.clone());
    assert_eq!(c.etat(), Etat::Absent);
    assert_eq!(c.deverrouiller(MDP), Err(Erreur::Absent));
    assert!(matches!(c.creer("court"), Err(Erreur::MotDePasseTropCourt)));
    c.creer(MDP).unwrap();
    assert_eq!(c.etat(), Etat::Ouvert);
    assert!(matches!(c.creer(MDP), Err(Erreur::DejaCree)));
}

#[test]
fn sans_fenetre_ne_garde_que_la_classe() {
    let d = Dossier::nouveau("classe");
    let (mut c, _) = coffre_cree(&d);
    c.poser("mcp:fond", VALEUR, Classe::SansFenetre).unwrap();
    assert_eq!(c.lire("mcp:fond").unwrap(), None);
    assert_eq!(c.classe("mcp:fond").unwrap(), Some(Classe::SansFenetre));
    assert!(c.table_mcp().unwrap().is_empty());
    assert!(c.retirer("mcp:fond").unwrap());
    assert!(!c.retirer("mcp:fond").unwrap());
}

#[test]
fn les_erreurs_ne_citent_aucune_valeur() {
    let d = Dossier::nouveau("erreurs");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:a", VALEUR, Classe::Coffre).unwrap();
    let erreurs = [
        Erreur::Absent,
        Erreur::DejaCree,
        Erreur::Verrouille,
        Erreur::MotDePasseIncorrect,
        Erreur::MotDePasseTropCourt,
        Erreur::CleDeSecoursInvalide,
        Erreur::Patienter(3),
    ];
    for e in erreurs {
        let m = e.to_string();
        assert!(!m.contains(VALEUR) && !m.contains(MDP));
    }
    c.verrouiller();
    let m = c.deverrouiller("mauvais-mot-de-passe").unwrap_err().to_string();
    assert!(!m.contains("mauvais-mot-de-passe"), "le mot de passe saisi ne revient pas dans l'erreur");
}

#[test]
fn liste_noms_classes_sans_valeur() {
    let d = Dossier::nouveau("liste");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:x", VALEUR, Classe::Coffre).unwrap();
    c.poser("mcp:fond", "v", Classe::SansFenetre).unwrap();
    let liste = c.liste().unwrap();
    assert_eq!(liste.len(), 2);
    assert!(liste.iter().any(|(n, k, _)| n == "mcp:fond" && *k == Classe::SansFenetre));
    let texte = format!("{liste:?}");
    assert!(!texte.contains(VALEUR), "la liste ne porte aucune valeur");
}

/// Migration (§ 7.3) : les originaux ne partent qu'après une relecture
/// conforme du fichier sur le disque. Ici, le disque « perd » une écriture.
#[test]
fn relecture_detecte_un_disque_non_conforme() {
    let d = Dossier::nouveau("relecture");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:a", "va", Classe::Coffre).unwrap();
    let noms = vec!["provider:a".to_string()];
    assert!(c.relecture_non_conformes(&noms).unwrap().is_empty(), "écrit puis relu : conforme");
    c.poser("provider:b", "vb", Classe::Coffre).unwrap();
    // Le disque revient à la version précédente (sans b) : b doit être signalé.
    fs::copy(d.0.join(FICHIER_PRECEDENT), d.0.join(FICHIER_COFFRE)).unwrap();
    let nc = c.relecture_non_conformes(&["provider:a".into(), "provider:b".into()]).unwrap();
    assert_eq!(nc, vec!["provider:b".to_string()]);
}

#[test]
fn cle_abimee_n_est_pas_un_mauvais_mot_de_passe() {
    let d = Dossier::nouveau("cle-abimee");
    let (mut c, _) = coffre_cree(&d);
    c.verrouiller();
    fs::write(d.0.join(FICHIER_CLE), b"age-encryption.org/v1\n-> pas un en-tete valide\n").unwrap();
    let mut c2 = Coffre::pour_tests(d.0.clone());
    for _ in 0..4 {
        match c2.deverrouiller(MDP) {
            Err(Erreur::Technique(m)) => assert!(m.contains("clé de secours"), "{m}"),
            autre => panic!("attendu une erreur technique, reçu {autre:?}"),
        }
    }
    // Aucun essai compté : pas de délai sur un fichier abîmé.
    assert!(c2.controler_delai().is_ok());
}

#[test]
fn changement_de_mot_de_passe_soumis_au_delai() {
    let d = Dossier::nouveau("chg-delai");
    let (mut c, _) = coffre_cree(&d);
    for _ in 0..ECHECS_SANS_DELAI {
        assert_eq!(c.changer_mot_de_passe(Some("faux-faux-faux"), "nouveau-mdp-1"), Err(Erreur::MotDePasseIncorrect));
    }
    assert!(
        matches!(c.changer_mot_de_passe(Some(MDP), "nouveau-mdp-1"), Err(Erreur::Patienter(_))),
        "même le bon mot de passe attend après trois échecs"
    );
    c.lever_delai();
    c.changer_mot_de_passe(Some(MDP), "nouveau-mdp-1").expect("après le délai");
}

#[test]
fn creation_interrompue_cle_sans_table_ouvre_un_coffre_vide() {
    let d = Dossier::nouveau("sans-table");
    let (mut c, _) = coffre_cree(&d);
    c.verrouiller();
    fs::remove_file(d.0.join(FICHIER_COFFRE)).unwrap();
    let mut c2 = Coffre::pour_tests(d.0.clone());
    assert_eq!(c2.etat(), Etat::Verrouille);
    c2.deverrouiller(MDP).expect("coffre vide, ouvert");
    assert!(c2.liste().unwrap().is_empty());
    assert!(d.0.join(FICHIER_COFFRE).exists(), "table réécrite aussitôt");
    c2.poser("provider:x", VALEUR, Classe::Coffre).unwrap();
}

#[test]
fn repli_sur_la_version_precedente_signale_et_ne_l_ecrase_pas() {
    let d = Dossier::nouveau("repli");
    let (mut c, _) = coffre_cree(&d);
    c.poser("provider:a", "valeur-a", Classe::Coffre).unwrap();
    c.poser("provider:b", "valeur-b", Classe::Coffre).unwrap(); // .prec = {a}
    c.verrouiller();
    fs::write(d.0.join(FICHIER_COFFRE), b"abime").unwrap();
    let prec_avant = fs::read(d.0.join(FICHIER_PRECEDENT)).unwrap();

    let mut c2 = Coffre::pour_tests(d.0.clone());
    c2.deverrouiller(MDP).expect("ouvert sur .prec");
    assert!(c2.repli_precedent(), "le repli se voit");
    assert_eq!(c2.lire("provider:a").unwrap().as_deref(), Some("valeur-a"));
    assert_eq!(c2.lire("provider:b").unwrap(), None, "dernière écriture perdue, et c'est dit");

    c2.poser("provider:c", "valeur-c", Classe::Coffre).unwrap();
    assert_eq!(fs::read(d.0.join(FICHIER_PRECEDENT)).unwrap(), prec_avant, ".prec pas écrasé par le fichier abîmé");
    assert!(!c2.repli_precedent(), "écriture réussie : repli terminé");
}

#[test]
fn disque_conforme_apres_retrait_et_ecriture() {
    let d = Dossier::nouveau("conforme");
    let (mut c, _) = coffre_cree(&d);
    c.poser("mcp:x", "valeur-x", Classe::Coffre).unwrap();
    assert!(c.disque_conforme("mcp:x").unwrap());
    c.retirer("mcp:x").unwrap();
    assert!(c.disque_conforme("mcp:x").unwrap(), "absent des deux côtés");
}

// ---------------------------------------------------------------------------
// Déverrouillage automatique par l'identité (T-225)
// ---------------------------------------------------------------------------

#[test]
fn identite_courante_coffre_ferme_est_verrouille() {
    let d = Dossier::nouveau("id-ferme");
    let (mut c, _) = coffre_cree(&d);
    c.verrouiller();
    assert!(matches!(c.identite_courante(), Err(Erreur::Verrouille)));
}

#[test]
fn aller_retour_par_l_identite_courante() {
    let d = Dossier::nouveau("id-aller-retour");
    let (mut c, secours) = coffre_cree(&d);
    c.poser("provider:x", VALEUR, Classe::Coffre).unwrap();
    let identite = c.identite_courante().expect("coffre ouvert").expose_secret().to_owned();
    assert_eq!(identite, secours, "l'identité est la clé de secours");
    c.verrouiller();

    let mut c2 = Coffre::pour_tests(d.0.clone());
    c2.deverrouiller_par_identite(&identite).expect("ouverture par l'identité");
    assert_eq!(c2.etat(), Etat::Ouvert);
    assert_eq!(c2.lire("provider:x").unwrap().as_deref(), Some(VALEUR));
}

#[test]
fn mauvaise_identite_refusee_sans_compter_d_echec() {
    let d = Dossier::nouveau("id-mauvaise");
    let (mut c, _) = coffre_cree(&d);
    c.verrouiller();
    let etrangere = age::x25519::Identity::generate().to_string().expose_secret().to_owned();
    for _ in 0..(ECHECS_SANS_DELAI + 2) {
        let e = c.deverrouiller_par_identite(&etrangere).expect_err("identité étrangère");
        assert!(matches!(e, Erreur::Technique(_)), "pas « mot de passe incorrect » : {e:?}");
        assert!(!e.to_string().contains(&etrangere), "l'identité ne paraît pas dans l'erreur");
    }
    let e = c.deverrouiller_par_identite("pas une identité").expect_err("illisible");
    assert!(matches!(e, Erreur::Technique(_)));
    assert_eq!(c.etat(), Etat::Verrouille, "état inchangé");
    assert_eq!(c.echecs, 0, "aucun essai de mot de passe compté");
    assert!(c.prochain_essai.is_none(), "aucun délai imposé");
    c.deverrouiller(MDP).expect("le mot de passe reste utilisable aussitôt");
}

#[test]
fn identite_sans_table_ne_reecrit_pas_le_coffre() {
    let d = Dossier::nouveau("id-sans-table");
    let (mut c, _) = coffre_cree(&d);
    c.verrouiller();
    fs::remove_file(d.0.join(FICHIER_COFFRE)).unwrap();
    let etrangere = age::x25519::Identity::generate().to_string().expose_secret().to_owned();
    assert!(c.deverrouiller_par_identite(&etrangere).is_err());
    assert!(!d.0.join(FICHIER_COFFRE).exists(), "aucune table écrite sous une identité étrangère");
    c.deverrouiller(MDP).expect("le mot de passe recrée la table vide, comme avant");
}
