# GitHub — l'usine qualité du dépôt public

> Mis en place le 2026-08-09. Principe directeur : **le dépôt local est la
> vérité, GitHub est l'usine.** Le code s'écrit et se corrige ici ; GitHub
> vérifie, construit, surveille et expose. Rien ne se modifie directement sur
> le dépôt public — tout y arrive par instantané.

## 1. Publication : par pull request

```bash
npm run verif                     # application FERMÉE (cargo recompile la coquille)
npm run publier -- --verif-fait "Titre de l'instantané"
```

`scripts/publier-instantane.sh` fabrique **un** commit (`git commit-tree`)
portant l'arbre complet, parent = `main` public : l'historique local — antérieur
au nettoyage du 2026-08-07, donc porteur de traces personnelles — ne part
jamais. Le commit est signé de l'identité publique du produit, pas de la config
git du poste (qui porte une adresse nominative). Le script relance l'audit en
dernière position, pousse la branche jetable `instantane`, et affiche l'URL
d'ouverture de la PR.

**Pourquoi une PR et plus une poussée directe :** la PR fait tourner
`version.yml` sur deux machines vierges (Linux et Windows) AVANT la fusion.
Le poste local peut mentir par omission — T-011 : un fichier jamais `git add`
passait l'audit et les tests locaux, et manquait à l'instantané. Une machine
vierge ne connaît que l'instantané ; si lui est incomplet, elle casse.

Fusionner par **« Rebase and merge »** : l'historique public reste une ligne
d'instantanés, sans commits de fusion. Pour livrer une version après fusion :

```bash
git push git@github.com:duvamduvam/iaction.git <sha-fusionné>:refs/tags/vX.Y.Z
```

L'étiquette déclenche la construction des deux installeurs et la release
(voir `docs/empaquetage.md`).

## 2. Vérification en CI

`version.yml` rejoue la chaîne de `npm run verif` (lint, cliquet, audit
structurel, tests du miroir de tickets, vitest, tests sidecar, cargo) puis
construit les installeurs — sur poussée `main`, sur PR, et sur étiquette. Les
échecs voyagent par **annotations** : les journaux de run ne sont lisibles
qu'avec des droits d'administration, les annotations le sont par l'API
publique.

Les motifs littéraux de l'audit (`scripts/.audit-motifs`) ne sont pas
versionnés, par définition : la CI ne fait tourner que les règles
structurelles. L'audit complet reste un geste LOCAL, refait par le script de
publication.

## 3. CodeQL

`codeql.yml` analyse TypeScript, Rust et les workflows eux-mêmes — sur
poussée, sur PR, et chaque lundi matin (les requêtes évoluent : un passage
planifié trouve des défauts nouvellement reconnus dans du code inchangé).
C'est un regard que la chaîne locale n'a pas : flux de données dangereux,
injections, API risquées.

Les résultats arrivent dans l'onglet **Security → Code scanning**. Deux
conventions s'appliquent : tout constat retenu = un ticket dans
`docs/tickets.md` (l'onglet Security n'est pas une seconde liste), et la
correction se fait localement, publiée avec l'instantané suivant.

## 4. Dependabot : alertes OUI, pull requests NON

Les **alertes** de sécurité (npm, cargo, actions) sont précieuses : une CVE
dans une dépendance se signale toute seule. Les **PR automatiques**, elles,
sont incompatibles avec le modèle : elles modifieraient le dépôt public, qui
n'est pas la source de vérité — la mise à jour se fait localement et part
avec l'instantané suivant.

C'est pourquoi il n'y a **pas de fichier `.github/dependabot.yml`** : ce
fichier active les PR de mise à jour. Son absence est un choix, pas un oubli.

> **La raison structurelle, à ne pas oublier** : l'instantané remplace l'arbre
> ENTIER. Tout ce qui est fusionné sur `main` sans exister dans le dépôt local
> est donc **silencieusement annulé à la publication suivante** — une PR de bot
> fusionnée redeviendrait vulnérable sans que personne ne le voie passer. Une
> PR de Dependabot se **ferme** ; la montée de version se fait ici, et part
> avec l'instantané. Constaté le 2026-08-09 : quatre PR de bot attendaient sur
> `tools/mcp-imap` (voir T-012).

## 5. Tickets : le fichier commande, les issues suivent

`tickets.yml` reflète `docs/tickets.md` en issues à chaque poussée qui touche
le fichier : création à l'ouverture (labels type + priorité), fermeture à
l'archivage, retitrage si le fichier change. Sens unique — la logique est dans
`scripts/refleter-tickets.mjs`, testée sans réseau (`npm run tickets:test`,
inclus dans `verif` : une ligne de tableau malformée casse AVANT d'atteindre
le miroir).

Les issues ouvertes par des visiteurs (sans préfixe `T-nnn`) ne sont jamais
touchées. Un retour pertinent se transcrit à la main dans `docs/tickets.md` :
c'est ainsi qu'il entre au backlog — et l'issue d'origine se ferme avec un mot
de renvoi vers le ticket.

## 6. Le CLI `gh`

Installé le 2026-08-09, **sans droits d'administration et sans Snap** (le
trousseau de Snap est une source d'ennuis connue sur ce poste) : l'archive
officielle est dépliée dans `~/.local/bin`, déjà dans le `PATH`.

```bash
curl -sSL -o /tmp/gh.tar.gz \
  https://github.com/cli/cli/releases/download/v2.97.0/gh_2.97.0_linux_amd64.tar.gz
tar xzf /tmp/gh.tar.gz -C /tmp
install -m 755 /tmp/gh_2.97.0_linux_amd64/bin/gh ~/.local/bin/gh
gh auth login          # navigateur, à faire par l'utilisateur
```

Ce qu'il débloque depuis le poste : ouvrir une PR (`gh pr create`), suivre un
run (`gh run watch`, `gh run list`), vérifier les checks avant de fusionner,
lire les alertes Dependabot — et **prévisualiser le miroir des tickets**
(`npm run tickets:miroir`), qui liste les issues même en lecture seule.

Le jeton part dans le **trousseau du système** (vérifié : `gh auth status`
affiche « keyring »), pas dans un fichier du dépôt — l'audit de publication
n'a donc rien à voir ici, et il ne faut jamais le recopier dans le projet.
Corollaire à garder en tête : un contexte sans trousseau (service headless,
`systemd-run`) ne verra pas ce jeton et aura besoin de `GH_TOKEN`.

**`origin` n'est PAS GitHub sur ce poste** (c'est la forge privée), donc `gh`
ne peut pas deviner le dépôt : les scripts le NOMMENT explicitement plutôt que
de le déduire — voir `depotCible()` dans `scripts/refleter-tickets.mjs` et le
ticket T-013, qui raconte la panne que la CI ne pouvait pas montrer.

## 7. Réglages du dépôt — à faire UNE FOIS, à la main

Ces réglages vivent côté GitHub, pas dans un fichier versionnable (certains
seraient scriptables par `gh api`, mais une case cochée une fois pour toutes
ne gagne rien à devenir un script) :

> **Piège** : GitHub a DEUX pages « Code security » — celle du **compte**
> (`github.com/settings/security_analysis`, boutons « Enable all / Disable
> all » et cases « pour les nouveaux dépôts ») et celle du **dépôt**. C'est
> celle du dépôt qu'il faut, sinon les options par dépôt (code scanning,
> protection de branche) sont introuvables. Adresses directes :
>
> - sécurité du dépôt : `github.com/duvamduvam/iaction/settings/security_analysis`
> - fusion : `github.com/duvamduvam/iaction/settings`
> - protection de branche : `github.com/duvamduvam/iaction/settings/branches`

**Settings du DÉPÔT → Code security**
- [ ] *Dependabot alerts* : **Enable** ;
- [ ] *Dependabot security updates* : **laisser désactivé** (§4 — pas de PR de bot) ;
- [ ] *Secret scanning* + *Push protection* : **Enable** (gratuit sur dépôt
      public ; deuxième filet derrière l'audit local) ;
- [ ] *Code scanning* : **ne pas** activer le « default setup » — c'est
      `codeql.yml` qui fait foi (§3).

**Settings → Branches → Add branch protection rule** (`main`)
- [ ] *Require a pull request before merging* (0 approbation requise : le
      portique est la CI, pas une revue à deux — il n'y a qu'un mainteneur) ;
- [ ] *Require status checks to pass* et cocher **`construire (ubuntu-latest)`**
      et **`construire (windows-latest)`** (ils n'apparaissent dans la liste
      qu'après un premier run sur PR).

**Settings → General → Pull Requests**
- [ ] Activer *Allow rebase merging* ; décocher *Allow merge commits*
      (historique public = une ligne d'instantanés).

Après le premier passage de `tickets.yml`, vérifier l'onglet **Issues** : les
quatre tickets ouverts doivent y être, avec leurs labels.
