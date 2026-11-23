import { describe, expect, it } from "vitest";
import type { ConfigVeilleur, StatutVeilleur } from "./veilleurClient";
import {
  configDepuisFormulaire,
  concerneLeProjet,
  encartNonApprouvee,
  FORMULAIRE_DEFAUT,
  formulaireDepuisConfig,
  libelleEtat,
  libelleIndicateur,
  motifDeScelle,
  nomDuProjet,
  resumeBilan,
} from "./veilleurFormulaire";

const config: ConfigVeilleur = {
  actif: true,
  expediteurs: ["maison"],
  agent: "publieur",
  compte: "perso",
  modele: "claude-opus-5-5",
  effort: "medium",
  permission: "bypassPermissions",
  bash: true,
  plafonds: { profondeur: 6, coutParMessage: 5, toursParJour: 100, dureeMin: 20 },
  cadenceSec: 30,
  url: "https://relay.example.net",
  jetonSecret: "relais.jeton",
  proxy: "http://proxy:8080",
};

const statut = (over: Partial<StatutVeilleur> = {}): StatutVeilleur => ({
  etat: "actif",
  cwd: "/projets/publication",
  motif: null,
  derniereReleve: null,
  dernierBilan: null,
  toursAujourdhui: 0,
  enCours: false,
  ...over,
});

describe("formulaire ⇄ config", () => {
  it("config APPROUVÉE : aller-retour sans perte, actif et agent affichés dans le formulaire", () => {
    const f = formulaireDepuisConfig(config, true);
    expect(f.actif).toBe(true);
    expect(f.agent).toBe("publieur");
    expect(configDepuisFormulaire(f)).toEqual({ config });
  });

  it("config NON approuvée : rien n'est repris en silence (actif non, aucun agent)", () => {
    const f = formulaireDepuisConfig(config, false);
    expect(f.actif).toBe(false);
    expect(f.agent).toBe("");
    const r = configDepuisFormulaire(f);
    expect("config" in r && r.config.actif).toBe(false);
    expect("config" in r && r.config.agent).toBeNull();
  });

  it("ce qui est scellé vient du formulaire : l'agent choisi part tel quel", () => {
    const r = configDepuisFormulaire({ ...formulaireDepuisConfig(config), agent: "autre-agent" });
    expect("config" in r && r.config.agent).toBe("autre-agent");
  });

  it("encart d'une config non approuvée", () => {
    expect(encartNonApprouvee(null)).toContain("Aucune version approuvée");
    expect(encartNonApprouvee(["url", "agent"])).toContain("url, agent");
    expect(encartNonApprouvee([])).toContain("fichier qu'il désigne");
  });

  it("la permission découle de Bash, jamais choisie", () => {
    const sans = configDepuisFormulaire({ ...formulaireDepuisConfig(config), bash: false });
    expect("config" in sans && sans.config.permission).toBe("acceptEdits");
    const avec = configDepuisFormulaire({ ...formulaireDepuisConfig(config), bash: true });
    expect("config" in avec && avec.config.permission).toBe("bypassPermissions");
  });

  it("config neuve : inactive, sans agent, compte perso", () => {
    const r = configDepuisFormulaire({ ...FORMULAIRE_DEFAUT, url: "https://relay.example.net", expediteurs: "maison, autre " });
    if (!("config" in r)) throw new Error(r.erreur);
    expect(r.config.actif).toBe(false);
    expect(r.config.agent).toBeNull();
    expect(r.config.compte).toBe("perso");
    expect(r.config.expediteurs).toEqual(["maison", "autre"]);
    expect(r.config.proxy).toBeUndefined();
  });

  it.each([
    [{ url: "http://x" }, "https://"],
    [{ jetonSecret: " " }, "secret"],
    [{ expediteurs: " , " }, "émetteur"],
    [{ cadenceSec: "5" }, "Cadence"],
    [{ dureeMin: "abc" }, "Durée"],
    [{ profondeur: "2.5" }, "entier"],
  ])("refus lisible : %o", (patch, attendu) => {
    const r = configDepuisFormulaire({ ...formulaireDepuisConfig(config), ...patch });
    expect("erreur" in r && r.erreur).toContain(attendu);
  });

  it.each([
    [{ coutParMessage: "0" }, "plus de 0"],
    [{ coutParMessage: "50.5" }, "Coût"],
    [{ toursParJour: "0" }, "Tours"],
    [{ toursParJour: "501" }, "Tours"],
    [{ profondeur: "21" }, "Allers-retours"],
    [{ dureeMin: "121" }, "Durée"],
    [{ expediteurs: "Maison" }, "nom de boîte"],
    [{ expediteurs: "?" }, "nom de boîte"],
  ])("bornes du sidecar suivies, aucun « 0 = illimité » : %o", (patch, attendu) => {
    const r = configDepuisFormulaire({ ...formulaireDepuisConfig(config), ...patch });
    expect("erreur" in r && r.erreur).toContain(attendu);
  });

  it("coût à virgule accepté", () => {
    const r = configDepuisFormulaire({ ...formulaireDepuisConfig(config), coutParMessage: "2,5" });
    expect("config" in r && r.config.plafonds.coutParMessage).toBe(2.5);
  });
});

describe("libellés", () => {
  it("états et tons", () => {
    expect(libelleEtat("actif")).toEqual({ texte: "actif", ton: "ok" });
    expect(libelleEtat("suspendu").ton).toBe("bad");
    expect(libelleEtat("en-attente-coffre").texte).toBe("en attente du coffre");
    expect(libelleEtat("inactif").ton).toBe("off");
    expect(libelleEtat("arret-en-cours")).toEqual({ texte: "arrêt en cours", ton: "warn" });
    expect(libelleIndicateur(statut({ etat: "arret-en-cours" }))).toBe("Veilleur arrêt en cours · publication");
  });

  it("indicateur d'en-tête : rien quand inactif, nom du projet sinon", () => {
    expect(libelleIndicateur(null)).toBeNull();
    expect(libelleIndicateur(statut({ etat: "inactif" }))).toBeNull();
    expect(libelleIndicateur(statut())).toBe("Veilleur actif · publication");
    expect(libelleIndicateur(statut({ etat: "suspendu" }))).toBe("Veilleur suspendu · publication");
  });

  it("motif de config non approuvée reconnu (geste montré)", () => {
    expect(motifDeScelle("config du relais modifiée hors de l'interface : ré-enregistre-la dans la section Veilleur")).toBe(true);
    expect(motifDeScelle("coffre fermé")).toBe(false);
    expect(motifDeScelle(null)).toBe(false);
  });

  it("nom du projet, chemins Windows compris", () => {
    expect(nomDuProjet("C:\\projets\\site\\")).toBe("site");
    expect(nomDuProjet("/a/b")).toBe("b");
  });

  it("le statut ne concerne que le projet veilleur", () => {
    expect(concerneLeProjet(statut(), "/projets/publication")).toBe(true);
    expect(concerneLeProjet(statut(), "/autre")).toBe(false);
    expect(concerneLeProjet(null, "/autre")).toBe(false);
  });

  it("bilan en une ligne", () => {
    expect(resumeBilan(statut())).toBe("aucune relève encore");
    expect(resumeBilan(statut({ dernierBilan: { traites: [], refuses: [], ignores: [], invalides: [], suspendu: false } }))).toBe("boîte vide");
    expect(resumeBilan(statut({ dernierBilan: { traites: ["a"], refuses: [], ignores: ["b", "c"], invalides: [], suspendu: false } }))).toBe(
      "1 traité(s), 2 laissé(s) en boîte",
    );
  });
});
