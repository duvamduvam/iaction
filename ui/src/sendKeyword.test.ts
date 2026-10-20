/*
 * matchSendKeyword — le mot-clé d'envoi en fin de dictée.
 *
 * Chaque cas de ce fichier correspond à un comportement APPRIS À LA DURE face
 * aux réécritures de Whisper (voir l'en-tête de sendKeyword.ts) : graphies
 * instables, homophones, découpage « en voie », élisions, et les garde-fous
 * grammaticaux qui évitent d'envoyer au milieu d'une vraie phrase. Si un de
 * ces tests casse, c'est qu'une régression réintroduit un faux départ ou un
 * faux blocage constaté en usage réel.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SEND_KEYWORD, matchSendKeyword } from "./sendKeyword";

describe("mot-clé par défaut (« banane »)", () => {
  it("déclenche en fin de phrase et retire le mot-clé du corps", () => {
    expect(matchSendKeyword("Voilà ma question, banane.")).toEqual({
      body: "Voilà ma question",
      send: true,
      reason: "declenche",
    });
  });

  it("tolère les graphies de Whisper : sans « s », majuscules, accents parasites", () => {
    expect(matchSendKeyword("C'est bon bananes").send).toBe(true);
    expect(matchSendKeyword("C'est bon BANANE !").send).toBe(true);
  });

  it("tolère la ponctuation fermante multiple", () => {
    expect(matchSendKeyword("C'est parti, banane… »").send).toBe(true);
  });

  it("mot-clé seul : corps vide, envoi quand même", () => {
    expect(matchSendKeyword("Banane.")).toEqual({ body: "", send: true, reason: "declenche" });
  });

  it("ne déclenche PAS au milieu du texte", () => {
    expect(matchSendKeyword("banane ce fichier à Paul").send).toBe(false);
  });

  it("ne déclenche PAS derrière un déterminant (le mot-clé est alors un vrai nom)", () => {
    expect(matchSendKeyword("ce midi j'ai mangé une banane").send).toBe(false);
    expect(matchSendKeyword("passe-moi la banane").send).toBe(false);
  });

  it("garde la ponctuation de phrase mais retire la virgule de liaison", () => {
    expect(matchSendKeyword("Voilà. Banane").body).toBe("Voilà.");
    expect(matchSendKeyword("Voilà, banane").body).toBe("Voilà");
  });

  it("texte vide ou blanc : rien ne part", () => {
    expect(matchSendKeyword("")).toEqual({ body: "", send: false, reason: "absent" });
    expect(matchSendKeyword("   ").send).toBe(false);
  });
});

describe("T-125 : la raison de la décision, rendue par le module lui-même", () => {
  it("« absent » : aucune occurrence du mot-clé en fin de texte", () => {
    expect(matchSendKeyword("banane ce fichier à Paul").reason).toBe("absent");
  });

  it("« bloque-pronom-devant » : déterminant/pronom collé, en milieu de phrase", () => {
    expect(matchSendKeyword("ce midi j'ai mangé une banane").reason).toBe("bloque-pronom-devant");
    expect(matchSendKeyword("passe-moi la banane").reason).toBe("bloque-pronom-devant");
  });

  it("« bloque-usage-grammatical » : famille « envoie », pronom devant — bloquée même en tête", () => {
    expect(matchSendKeyword("je l'envoie", "envoie").reason).toBe("bloque-usage-grammatical");
    expect(matchSendKeyword("tu en vois", "envoie").reason).toBe("bloque-usage-grammatical");
  });

  it("« declenche-graphie-approchee » : reconnu par le squelette consonantique seulement", () => {
    expect(matchSendKeyword("voilà ma question Banana.").reason).toBe("declenche-graphie-approchee");
    expect(matchSendKeyword("voilà ma question Benen.").reason).toBe("declenche-graphie-approchee");
  });

  it("« declenche » : forme exacte, pas de squelette approché", () => {
    expect(matchSendKeyword("Voilà ma question, banane.").reason).toBe("declenche");
    expect(matchSendKeyword("Je transmets.", "transmets").reason).toBe("declenche");
  });
});

describe("régression T-126 : le mot-clé bien entendu, mal orthographié", () => {
  /*
   * Formes relevées le 2026-09-06 dans le composeur, sur un « banane »
   * prononcé clairement à chaque fois. Le squelette consonantique les rattrape
   * toutes — voir `consonantSkeleton` dans sendKeyword.ts.
   */
  it("accepte les graphies constatées : Banana, Benen, Bananne", () => {
    for (const forme of ["Banana.", "Benen.", "Bananne.", "banannes", "Bannane."]) {
      expect(matchSendKeyword(`voilà ma question ${forme}`).send).toBe(true);
    }
  });

  it("le corps reste propre quelle que soit la graphie", () => {
    expect(matchSendKeyword("Voilà ma question. Banana. Benen.")).toEqual({
      body: "Voilà ma question.",
      send: true,
      reason: "declenche-graphie-approchee",
    });
  });

  it("ne confond pas avec un mot au squelette différent", () => {
    expect(matchSendKeyword("passe-moi le bandana").send).toBe(false);
    expect(matchSendKeyword("c'est une bonne banquise").send).toBe(false);
  });
});

describe("régression T-123 : le mot-clé répété quand rien ne part", () => {
  /*
   * Cas relevés MOT POUR MOT dans l'historique de conversation du 2026-09-06,
   * où « transmets » (un verbe) n'a jamais déclenché : l'utilisateur a répété
   * le mot, et Whisper l'a rhabillé en phrase avec un pronom. Les deux
   * comportements doivent envoyer, et rendre un corps propre.
   */
  it("répétitions : toutes les occurrences quittent le corps", () => {
    expect(matchSendKeyword("Voilà ma question. Banane, banane, banane.")).toEqual({
      body: "Voilà ma question.",
      send: true,
      reason: "declenche",
    });
    expect(matchSendKeyword("Je transmets, je transmets, je transmet", "transmets")).toEqual({
      body: "",
      send: true,
      reason: "declenche",
    });
  });

  it("pronom ajouté par Whisper devant un mot-clé lancé seul : envoi", () => {
    expect(matchSendKeyword("Je transmets.", "transmets").send).toBe(true);
    expect(matchSendKeyword("Voilà ma question. Je transmets.", "transmets")).toEqual({
      body: "Voilà ma question.",
      send: true,
      reason: "declenche",
    });
  });

  it("mais au fil d'une phrase, l'usage verbal reste bloqué", () => {
    expect(matchSendKeyword("c'est le rapport que je te transmets", "transmets").send).toBe(false);
  });
});

describe("famille « envoie » (mot-clé configuré fragile, mécanique dédiée)", () => {
  it("reconnaît les homophones réécrits par Whisper", () => {
    for (const fin of ["envoie", "envoi", "envoyer", "Envoie."]) {
      expect(matchSendKeyword(`ma question ${fin}`, "envoie").send).toBe(true);
    }
  });

  it("reconnaît le recollage élidé « l'envoi » (réécriture Whisper)", () => {
    const r = matchSendKeyword("ma question, l'envoi.", "envoie");
    expect(r.send).toBe(true);
    expect(r.body).toBe("ma question");
  });

  it("reconnaît la forme découpée « en voie » ([ɑ̃vwa] en deux mots)", () => {
    const r = matchSendKeyword("les régions souveraines en voie.", "envoie");
    expect(r.send).toBe(true);
    expect(r.body).toBe("les régions souveraines");
  });

  it("ne déclenche PAS sur les vraies tournures grammaticales", () => {
    // Cette famille est trop proche du français courant : contrairement aux
    // autres mots-clés, un pronom devant bloque TOUJOURS, même en tête de
    // segment (« Je l'envoie. » est une phrase que l'on dicte pour de vrai).
    expect(matchSendKeyword("que je t'envoie", "envoie").send).toBe(false);
    expect(matchSendKeyword("je l'envoie", "envoie").send).toBe(false);
    expect(matchSendKeyword("tu en vois", "envoie").send).toBe(false);
    expect(matchSendKeyword("j'en vois", "envoie").send).toBe(false);
  });
});

describe("mot-clé configuré quelconque", () => {
  it("comparaison normalisée, tolérance du « s » final", () => {
    expect(matchSendKeyword("c'est fini, valide", "valides").send).toBe(true);
    expect(matchSendKeyword("c'est fini, valides", "valide").send).toBe(true);
  });

  it("réglage à rallonge : seul le dernier mot compte", () => {
    expect(matchSendKeyword("ok envoi final", "envoi final").send).toBe(true);
  });

  it("réglage vide ou blanc : retombe sur le défaut", () => {
    expect(matchSendKeyword("bon, banane", "  ").send).toBe(true);
    expect(DEFAULT_SEND_KEYWORD).toBe("banane");
  });

  it("élision collée = vrai mot du texte, pas le mot-clé", () => {
    expect(matchSendKeyword("c'est l'unique", "unique").send).toBe(false);
  });
});
