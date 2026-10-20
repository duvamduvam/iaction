/*
 * Archivage des sessions hors plafond (T-151) : les invariants qui font qu'un
 * historique ne disparaît plus en silence. Le pire scénario n'est pas un test
 * rouge : c'est une session qui quitte `projet-<id>.json` sans qu'aucune
 * archive ne la retienne.
 */

import { describe, expect, it } from "vitest";

import {
  archiver,
  chargerIndexArchives,
  choisirArchivables,
  nomArchive,
  nomIndexArchives,
  PREFIXE_ARCHIVE,
  PREFIXE_INDEX_ARCHIVES,
  restaurer,
  retirerArchive,
  sansVifs,
  type EntreeArchive,
  type Journaliser,
} from "./archivesSessions";
import type { IoEtat } from "./etatEclate";
import { PREFIXE_PROJET } from "./etatEclate";
import type { PersistedProjectEntry, PersistedSession } from "./modeleProjet";

/** Faux magasin (mêmes règles que state_store.rs) avec pannes d'écriture programmables. */
function fauxMagasin(initial: Record<string, unknown> = {}) {
  const fichiers = new Map<string, unknown>(Object.entries(initial));
  const ecritures: string[] = [];
  const pannes = new Set<string>();
  const io: IoEtat = {
    lire: async (nom) => fichiers.get(nom) ?? {},
    ecrire: async (nom, valeur) => {
      if (pannes.has(nom)) throw new Error("disque plein");
      ecritures.push(nom);
      fichiers.set(nom, JSON.parse(JSON.stringify(valeur)));
    },
    lister: async (prefixe) => [...fichiers.keys()].filter((n) => n.startsWith(prefixe)).sort(),
    renommer: async (nom, nouveau) => {
      if (fichiers.has(nouveau)) throw new Error("cible déjà existante");
      if (!fichiers.has(nom)) throw new Error("source absente");
      fichiers.set(nouveau, fichiers.get(nom));
      fichiers.delete(nom);
    },
  };
  return { io, fichiers, ecritures, pannes };
}

function espion() {
  const lignes: Array<{ niveau: string; msg: string }> = [];
  const journaliser: Journaliser = (niveau, msg) => void lignes.push({ niveau, msg });
  return { journaliser, lignes };
}

/** Session `n` : plus `n` est grand, plus elle est récente. */
function session(n: number): PersistedSession {
  const iso = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  return {
    id: `s${n}`,
    title: `Session ${n}`,
    titleCustom: false,
    createdAt: iso,
    updatedAt: iso,
    turns: [],
    sessionId: null,
  };
}

function entree(n: number, activeId: string, ouvertes: string[] = [activeId]): PersistedProjectEntry {
  return {
    sessions: Array.from({ length: n }, (_, i) => session(i + 1)),
    activeId,
    openConversationIds: ouvertes,
    openFilePaths: [],
    activeTab: "",
  };
}

describe("noms et préfixes", () => {
  it("ne commencent pas par `projet-` : chargerProjets ne les prendrait pas pour des projets", () => {
    expect(PREFIXE_ARCHIVE.startsWith(PREFIXE_PROJET)).toBe(false);
    expect(PREFIXE_INDEX_ARCHIVES.startsWith(PREFIXE_PROJET)).toBe(false);
    expect(nomArchive("f81d4fae-7dec-11d0-a765-00a0c91e6bf6")).toBe("projarch-f81d4fae-7dec-11d0-a765-00a0c91e6bf6");
    expect(nomIndexArchives("didier")).toBe("archives-didier");
  });

  it("l'index est PAR projet", () => {
    expect(nomIndexArchives("a")).not.toBe(nomIndexArchives("b"));
  });
});

describe("choisirArchivables (invariant 2)", () => {
  it("n'archive rien sous le plafond", () => {
    expect(choisirArchivables(entree(5, "s5"), 30)).toEqual([]);
  });

  it("archive les plus anciennes au-delà du plafond", () => {
    expect(choisirArchivables(entree(5, "s5"), 3).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("épargne la session active et les onglets ouverts, même anciens", () => {
    const e = entree(5, "s1", ["s1", "s2"]);
    expect(choisirArchivables(e, 2).map((s) => s.id)).toEqual(["s3"]);
  });

  it("épargne une session qui porte un réveil armé", () => {
    const e = entree(5, "s5");
    e.sessions[0] = { ...e.sessions[0], reveils: [{}] as never };
    expect(choisirArchivables(e, 3).map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("archiver (invariants 1 et 4)", () => {
  it("écrit l'archive complète, l'index, et rend les ids acquis", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser, lignes } = espion();
    const r = await archiver(io, "didier", [session(1)], [], new Map(), journaliser);
    expect(r.archivees).toEqual(["s1"]);
    expect(fichiers.get("projarch-s1")).toEqual({ projetId: "didier", session: session(1) });
    expect((fichiers.get("archives-didier") as { archives: EntreeArchive[] }).archives).toEqual([
      { id: "s1", title: "Session 1", titleCustom: false, createdAt: session(1).createdAt, updatedAt: session(1).updatedAt, nbTours: 0 },
    ]);
    expect(lignes).toEqual([]);
  });

  it("si l'écriture de l'archive échoue : la session n'est PAS acquise, et l'échec est journalisé", async () => {
    const { io, pannes, fichiers } = fauxMagasin();
    pannes.add("projarch-s1");
    const { journaliser, lignes } = espion();
    const r = await archiver(io, "didier", [session(1), session(2)], [], new Map(), journaliser);
    expect(r.archivees).toEqual(["s2"]);
    expect(fichiers.has("projarch-s1")).toBe(false);
    expect(lignes.map((l) => l.niveau)).toEqual(["error"]);
    expect(r.index.map((e) => e.id)).toEqual(["s2"]);
  });

  it("si l'index n'est pas écrit : rien n'est acquis (une archive introuvable est une archive perdue)", async () => {
    const { io, pannes } = fauxMagasin();
    pannes.add("archives-didier");
    const { journaliser, lignes } = espion();
    const r = await archiver(io, "didier", [session(1)], [], new Map(), journaliser);
    expect(r.archivees).toEqual([]);
    expect(r.index).toEqual([]);
    expect(lignes.map((l) => l.niveau)).toEqual(["error"]);
  });

  it("ne réécrit pas une archive inchangée, mais la réécrit dès qu'elle change", async () => {
    const { io, ecritures } = fauxMagasin();
    const { journaliser } = espion();
    const deja = new Map<string, string>();
    const premier = await archiver(io, "didier", [session(1)], [], deja, journaliser);
    const avant = ecritures.length;
    const second = await archiver(io, "didier", [session(1)], premier.index, deja, journaliser);
    expect(second.archivees).toEqual(["s1"]);
    expect(ecritures.length).toBe(avant); // ni l'archive ni l'index

    await archiver(io, "didier", [{ ...session(1), title: "Renommée", titleCustom: true }], second.index, deja, journaliser);
    expect(ecritures.filter((n) => n === "projarch-s1")).toHaveLength(2);
  });

  it("garde l'index trié du plus récent au plus ancien, sans doublon", async () => {
    const { io } = fauxMagasin();
    const { journaliser } = espion();
    const a = await archiver(io, "p", [session(1)], [], new Map(), journaliser);
    const b = await archiver(io, "p", [session(3), session(1)], a.index, new Map(), journaliser);
    expect(b.index.map((e) => e.id)).toEqual(["s3", "s1"]);
  });
});

describe("chargerIndexArchives (invariant 3)", () => {
  it("ignore les entrées dont l'id existe en vif, et les retire de l'index écrit", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser } = espion();
    await archiver(io, "p", [session(1), session(2)], [], new Map(), journaliser);
    const liste = await chargerIndexArchives(io, "p", new Set(["s2"]), journaliser);
    expect(liste.map((e) => e.id)).toEqual(["s1"]);
    expect((fichiers.get("archives-p") as { archives: EntreeArchive[] }).archives.map((e) => e.id)).toEqual(["s1"]);
  });

  it("un index absent donne une liste vide, sans rien écrire", async () => {
    const { io, ecritures } = fauxMagasin();
    expect(await chargerIndexArchives(io, "p", new Set(), espion().journaliser)).toEqual([]);
    expect(ecritures).toEqual([]);
  });

  it("une lecture qui échoue est journalisée, pas avalée", async () => {
    const { io } = fauxMagasin();
    const { journaliser, lignes } = espion();
    const casse: IoEtat = { ...io, lire: async () => Promise.reject(new Error("illisible")) };
    expect(await chargerIndexArchives(casse, "p", new Set(), journaliser)).toEqual([]);
    expect(lignes.map((l) => l.niveau)).toEqual(["error"]);
  });

  it("sansVifs filtre sans muter", () => {
    const index = [resumeur(1), resumeur(2)];
    expect(sansVifs(index, new Set(["s1"])).map((e) => e.id)).toEqual(["s2"]);
    expect(index).toHaveLength(2);
  });
});

function resumeur(n: number): EntreeArchive {
  const s = session(n);
  return { id: s.id, title: s.title, titleCustom: false, createdAt: s.createdAt, updatedAt: s.updatedAt, nbTours: 0 };
}

describe("aller-retour archiver → restaurer", () => {
  it("rend la session à l'identique, l'insère AVANT de retirer l'index, et laisse le fichier", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser, lignes } = espion();
    const deja = new Map<string, string>();
    const orig = { ...session(1), title: "Robot", titleCustom: true };
    const a = await archiver(io, "didier", [orig], [], deja, journaliser);

    let indexAuMomentDeLInsertion: string[] = [];
    const r = await restaurer(io, "didier", "s1", a.index, deja, (s) => {
      indexAuMomentDeLInsertion = (fichiers.get("archives-didier") as { archives: EntreeArchive[] }).archives.map((e) => e.id);
      return s.id === "s1";
    }, journaliser);

    expect(r?.session).toEqual(orig);
    expect(r?.index).toEqual([]);
    expect(indexAuMomentDeLInsertion).toEqual(["s1"]); // encore listée quand on l'insère
    expect((fichiers.get("archives-didier") as { archives: EntreeArchive[] }).archives).toEqual([]);
    expect(fichiers.has("projarch-s1")).toBe(true); // rien n'est détruit
    expect(deja.has("s1")).toBe(false);
    expect(lignes).toEqual([]);
  });

  it("si l'appelant renonce (projet quitté), l'index n'est pas touché", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser } = espion();
    const a = await archiver(io, "didier", [session(1)], [], new Map(), journaliser);
    const r = await restaurer(io, "didier", "s1", a.index, new Map(), () => false, journaliser);
    expect(r).toBeNull();
    expect((fichiers.get("archives-didier") as { archives: EntreeArchive[] }).archives).toHaveLength(1);
  });

  it("un fichier d'archive absent ou invalide n'insère rien et se journalise", async () => {
    const { io } = fauxMagasin();
    const { journaliser, lignes } = espion();
    let insere = false;
    const r = await restaurer(io, "didier", "s9", [resumeur(9)], new Map(), () => (insere = true), journaliser);
    expect(r).toBeNull();
    expect(insere).toBe(false);
    expect(lignes.map((l) => l.niveau)).toEqual(["error"]);
  });

  it("un échec de retrait de l'index ne perd pas la session restaurée (le vif fait foi)", async () => {
    const { io, pannes } = fauxMagasin();
    const { journaliser, lignes } = espion();
    const a = await archiver(io, "didier", [session(1)], [], new Map(), journaliser);
    pannes.add("archives-didier");
    const r = await restaurer(io, "didier", "s1", a.index, new Map(), () => true, journaliser);
    expect(r?.session.id).toBe("s1");
    expect(lignes.map((l) => l.niveau)).toEqual(["warn"]);
  });
});

describe("retirerArchive : la corbeille ne détruit pas", () => {
  it("renomme sous retire-… et sort l'entrée de l'index", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser, lignes } = espion();
    const a = await archiver(io, "didier", [session(1), session(2)], [], new Map(), journaliser);
    const index = await retirerArchive(io, "didier", "s1", a.index, new Map(), journaliser);
    expect(index.map((e) => e.id)).toEqual(["s2"]);
    expect(fichiers.has("projarch-s1")).toBe(false);
    expect(fichiers.has("retire-projarch-s1")).toBe(true);
    expect(lignes).toEqual([]);
  });

  it("si l'index ne s'écrit pas, rien ne bouge (fichier compris)", async () => {
    const { io, fichiers, pannes } = fauxMagasin();
    const { journaliser, lignes } = espion();
    const a = await archiver(io, "didier", [session(1)], [], new Map(), journaliser);
    pannes.add("archives-didier");
    const index = await retirerArchive(io, "didier", "s1", a.index, new Map(), journaliser);
    expect(index).toEqual(a.index);
    expect(fichiers.has("projarch-s1")).toBe(true);
    expect(lignes.map((l) => l.niveau)).toEqual(["error"]);
  });
});
