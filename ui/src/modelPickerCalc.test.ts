/*
 * Sélecteur de modèle : ce qui se décide sans DOM.
 *
 * Le contrat qui compte est celui de la NON-PERTE : un filtre confortable
 * activé par défaut (masquer les variantes) n'a jamais le droit de faire
 * disparaître un modèle qu'on ne peut atteindre autrement, ni le modèle
 * actuellement sélectionné. Le reste (tri, groupes) est du confort.
 */
import { describe, expect, it } from "vitest";
import {
  baseDeVariante,
  construireListe,
  editeurDe,
  estGratuit,
  FILTRE_INITIAL,
  grouperParEditeur,
  ordreAffichage,
  rangEditeur,
  suffixeVariante,
  type ListeModeles,
} from "./modelPickerCalc";
import type { ModelDetail } from "./sidecar";

const modele = (id: string, extra: Partial<ModelDetail> = {}): ModelDetail => ({ id, ...extra });
const gratuit = { pricing: { promptUsdPerM: 0, completionUsdPerM: 0 } };

/** Tout ce qui n'est pas favori, groupes aplatis — l'ordre du rendu. */
const horsFavoris = (liste: ListeModeles): ModelDetail[] => liste.groupes.flatMap((g) => g.models);

describe("editeurDe", () => {
  it("prend la partie avant la barre", () => {
    expect(editeurDe("anthropic/claude-sonnet-5")).toBe("anthropic");
  });

  it("retire le préfixe décoratif de certains catalogues", () => {
    expect(editeurDe("~google/gemini-flash-latest")).toBe("google");
  });

  it("un id sans éditeur n'en invente pas un", () => {
    expect(editeurDe("llama3")).toBe("");
    expect(editeurDe("/orphelin")).toBe("");
  });
});

describe("baseDeVariante / suffixeVariante", () => {
  it("sépare le suffixe de variante", () => {
    expect(baseDeVariante("nvidia/nemotron-3.5-lightning:free")).toBe("nvidia/nemotron-3.5-lightning");
    expect(suffixeVariante("nvidia/nemotron-3.5-lightning:free")).toBe("free");
  });

  it("un id sans suffixe n'est pas une variante", () => {
    expect(baseDeVariante("openai/gpt-5.6-luna-pro")).toBeNull();
    expect(suffixeVariante("openai/gpt-5.6-luna-pro")).toBeNull();
  });
});

describe("estGratuit", () => {
  it("gratuit = les deux tarifs connus ET nuls", () => {
    expect(estGratuit(modele("a", gratuit))).toBe(true);
  });

  it("un tarif ABSENT n'est pas un tarif nul", () => {
    expect(estGratuit(modele("sans-prix"))).toBe(false);
    expect(estGratuit(modele("moitie", { pricing: { promptUsdPerM: 0 } }))).toBe(false);
  });
});

describe("construireListe — masquage des variantes", () => {
  it("masque la variante quand le modèle de base est là", () => {
    const models = [modele("nvidia/nemotron"), modele("nvidia/nemotron:free", gratuit)];
    const liste = construireListe(models, [], FILTRE_INITIAL, "");
    expect(horsFavoris(liste).map((m) => m.id)).toEqual(["nvidia/nemotron"]);
    expect(liste.variantesMasquees).toBe(1);
  });

  it("GARDE la variante orpheline : sans base, elle EST le modèle", () => {
    // Cas réel : `liquid/lfm-2.5-2.6b:free` n'a pas d'équivalent payant au
    // catalogue. La masquer retirerait le modèle, pas son doublon.
    const models = [modele("liquid/lfm-2.5-2.6b:free", gratuit)];
    const liste = construireListe(models, [], FILTRE_INITIAL, "");
    expect(horsFavoris(liste).map((m) => m.id)).toEqual(["liquid/lfm-2.5-2.6b:free"]);
    expect(liste.variantesMasquees).toBe(0);
  });

  it("le modèle SÉLECTIONNÉ échappe au masquage", () => {
    const models = [modele("nvidia/nemotron"), modele("nvidia/nemotron:free", gratuit)];
    const liste = construireListe(models, [], FILTRE_INITIAL, "nvidia/nemotron:free");
    expect(horsFavoris(liste).map((m) => m.id)).toEqual(["nvidia/nemotron", "nvidia/nemotron:free"]);
    expect(liste.variantesMasquees).toBe(0);
  });

  it("`variantes: true` rend tout, sans compteur", () => {
    const models = [modele("nvidia/nemotron"), modele("nvidia/nemotron:free", gratuit)];
    const liste = construireListe(models, [], { ...FILTRE_INITIAL, variantes: true }, "");
    expect(liste.total).toBe(2);
    expect(liste.variantesMasquees).toBe(0);
  });
});

describe("construireListe — favoris", () => {
  const models = [modele("a"), modele("b"), modele("c")];

  it("un favori n'apparaît JAMAIS deux fois", () => {
    const liste = construireListe(models, ["b"], FILTRE_INITIAL, "");
    expect(liste.favoris.map((m) => m.id)).toEqual(["b"]);
    expect(horsFavoris(liste).map((m) => m.id)).toEqual(["a", "c"]);
    expect(ordreAffichage(liste).map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("les favoris gardent l'ordre d'ajout, pas celui du tri", () => {
    const liste = construireListe(models, ["c", "a"], FILTRE_INITIAL, "");
    expect(liste.favoris.map((m) => m.id)).toEqual(["c", "a"]);
  });

  it("un favori disparu du catalogue ne casse rien", () => {
    const liste = construireListe(models, ["fantome"], FILTRE_INITIAL, "");
    expect(liste.favoris).toEqual([]);
    expect(liste.total).toBe(3);
  });
});

describe("grouperParEditeur", () => {
  it("regroupe les modèles épars d'un même éditeur, sans toucher à leur ordre", () => {
    const groupes = grouperParEditeur([
      modele("openai/gpt-5"),
      modele("anthropic/claude-sonnet-5"),
      modele("openai/gpt-4"),
    ]);
    expect(groupes.map((g) => g.editeur)).toEqual(["anthropic", "openai"]);
    expect(groupes[1].models.map((m) => m.id)).toEqual(["openai/gpt-5", "openai/gpt-4"]);
  });

  it("ordonne les groupes par PART DE TRAFIC, pas par ordre d'apparition", () => {
    const groupes = grouperParEditeur([
      modele("openai/gpt-5"),
      modele("deepseek/v4"),
      modele("google/gemini-3"),
    ]);
    expect(groupes.map((g) => g.editeur)).toEqual(["deepseek", "google", "openai"]);
  });

  it("les éditeurs hors relevé passent APRÈS les classés, entre eux par ordre alphabétique", () => {
    // Les classer au jugé serait inventer une hiérarchie que rien ne mesure.
    const groupes = grouperParEditeur([
      modele("z-ai/glm"),
      modele("mistralai/large"),
      modele("anthropic/claude"),
      modele("x-ai/grok"),
    ]);
    expect(groupes.map((g) => g.editeur)).toEqual(["anthropic", "mistralai", "x-ai", "z-ai"]);
  });

  it("le préfixe décoratif ne scinde pas un éditeur en deux groupes", () => {
    // Le catalogue OpenRouter sert `~anthropic/…` à côté d'`anthropic/…`.
    const groupes = grouperParEditeur([modele("anthropic/claude-5"), modele("~anthropic/claude-6")]);
    expect(groupes).toHaveLength(1);
    expect(groupes[0].models).toHaveLength(2);
  });

  it("les ids sans éditeur (Ollama) tiennent dans un groupe sans nom, placé en DERNIER", () => {
    const groupes = grouperParEditeur([modele("llama3.1:8b"), modele("z-ai/glm"), modele("mistral:7b")]);
    expect(groupes.map((g) => g.editeur)).toEqual(["z-ai", ""]);
    expect(groupes[1].models).toHaveLength(2);
  });

  it("le regroupement ne perd ni ne duplique aucun modèle", () => {
    const models = [modele("a/1"), modele("b/1"), modele("a/2"), modele("seul")];
    expect(grouperParEditeur(models).flatMap((g) => g.models)).toHaveLength(models.length);
  });
});

describe("rangEditeur", () => {
  it("le relevé est ordonné, du plus au moins de trafic", () => {
    expect(rangEditeur("deepseek")).toBeLessThan(rangEditeur("anthropic"));
    expect(rangEditeur("anthropic")).toBeLessThan(rangEditeur("openai"));
  });

  it("un éditeur hors relevé n'est pas classé dernier par erreur : il n'est pas classé", () => {
    expect(rangEditeur("mistralai")).toBe(Infinity);
    expect(rangEditeur("")).toBe(Infinity);
  });
});

describe("construireListe — regroupement", () => {
  it("les favoris restent HORS des groupes d'éditeur", () => {
    const models = [modele("openai/gpt-5"), modele("openai/gpt-4")];
    const liste = construireListe(models, ["openai/gpt-4"], FILTRE_INITIAL, "");
    expect(liste.favoris.map((m) => m.id)).toEqual(["openai/gpt-4"]);
    expect(horsFavoris(liste).map((m) => m.id)).toEqual(["openai/gpt-5"]);
    expect(ordreAffichage(liste).map((m) => m.id)).toEqual(["openai/gpt-4", "openai/gpt-5"]);
  });

  it("ordreAffichage suit les GROUPES, pas le tri : c'est lui que parcourt le clavier", () => {
    const models = [modele("a/1"), modele("b/1"), modele("a/2")];
    const liste = construireListe(models, [], FILTRE_INITIAL, "");
    // Trié par nom : a/1, a/2, b/1 — mais a/2 remonte dans le groupe « a ».
    expect(ordreAffichage(liste).map((m) => m.id)).toEqual(["a/1", "a/2", "b/1"]);
  });
});

describe("construireListe — recherche et tri", () => {
  const models = [
    modele("openai/gpt-5.6-luna-pro", { name: "OpenAI: GPT-5.6 Luna Pro", pricing: { promptUsdPerM: 5, completionUsdPerM: 20 } }),
    modele("anthropic/claude-sonnet-5", { name: "Anthropic: Claude Sonnet 5", pricing: { promptUsdPerM: 3, completionUsdPerM: 15 } }),
    modele("meta-llama/llama-3.1-70b-instruct", { name: "Meta: Llama 3.1 70B", ...gratuit }),
  ];

  it("cherche dans le nom ET dans l'id", () => {
    expect(construireListe(models, [], { ...FILTRE_INITIAL, recherche: "sonnet" }, "").total).toBe(1);
    expect(construireListe(models, [], { ...FILTRE_INITIAL, recherche: "meta-llama" }, "").total).toBe(1);
  });

  it("la recherche FILTRE mais ne réordonne pas : DANS un groupe, le tri reste maître", () => {
    // Trier par prix puis taper trois lettres ne doit pas rendre la liste au hasard.
    const memeEditeur = [
      modele("openai/cher", { pricing: { promptUsdPerM: 9, completionUsdPerM: 20 } }),
      modele("openai/donne", { pricing: { promptUsdPerM: 1, completionUsdPerM: 2 } }),
    ];
    const liste = construireListe(memeEditeur, [], { ...FILTRE_INITIAL, tri: "price-in", recherche: "o" }, "");
    expect(liste.groupes[0].models.map((m) => m.pricing?.promptUsdPerM)).toEqual([1, 9]);
  });

  it("changer de tri ne déplace PAS les éditeurs : « chez qui » ne dépend pas de « lequel »", () => {
    // Sinon le simple fait de trier par prix ferait sauter les groupes sous le curseur.
    const parNom = construireListe(models, [], FILTRE_INITIAL, "");
    const parPrix = construireListe(models, [], { ...FILTRE_INITIAL, tri: "price-in" }, "");
    expect(parPrix.groupes.map((g) => g.editeur)).toEqual(parNom.groupes.map((g) => g.editeur));
    expect(parNom.groupes.map((g) => g.editeur)).toEqual(["anthropic", "openai", "meta-llama"]);
  });

  it("aucune correspondance : liste vide, pas une liste complète", () => {
    expect(construireListe(models, [], { ...FILTRE_INITIAL, recherche: "zzzzz" }, "").total).toBe(0);
  });

  it("le filtre gratuit est explicite : il s'applique AUSSI au modèle courant", () => {
    const liste = construireListe(
      models,
      [],
      { ...FILTRE_INITIAL, gratuitSeulement: true },
      "anthropic/claude-sonnet-5",
    );
    expect(horsFavoris(liste).map((m) => m.id)).toEqual(["meta-llama/llama-3.1-70b-instruct"]);
  });
});
