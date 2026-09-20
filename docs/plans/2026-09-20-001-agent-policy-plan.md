# Politique de commandes des agents — source unique, Claude et Codex

Date de reprise : 2026-09-20 · Dépôt : `agent-policy` · Statut : plan accepté, réalisation en cours

Reprise de la fiche CoproOS `plan-complet-a-reprendre.md` du 2026-09-19. Les items et critères
ci-dessous gardent leur numérotation et leur texte d’origine, sauf le nom de commande de l’item 7,
remplacé avec l’accord du user. Les items 3 et 4 et leurs critères exclusivement associés (5 et 7)
restent dans CoproOS. Les critères 3 et 4 restent ici car ils sont aussi associés à l’item 2.

La PR #1 est relue ; sa fusion appartient au user. Cette reprise ne vaut ni installation réelle,
ni autorisation de modifier les réglages personnels ou CoproOS. L’item 5 reste à exécuter dans
une mission distincte. La mention historique « bloc permissions » des items 1 et 2 désigne
uniquement les entrées Bash : les autres permissions et réglages sont conservés.

Les constats et décisions ci-dessous sont ceux de la fiche source, datés du 2026-09-19.

## 1. Pourquoi

L'audit de `~/.codex/rules/default.rules` (272 lignes) a établi trois défauts :

- six règles larges (`npm run`, `npx tsx`, `with-env.sh`, `with-supabase-env.sh`, `sed`, `rg`)
  autorisent l'exécution arbitraire hors sandbox et rendent les règles fines inopérantes ;
- des actions qu'`AGENTS.md` réserve à une décision du user sont en `allow` : `gh pr` (donc
  `merge`), `gh workflow` (donc CI puis Deploy), `gh variable set`, `git push`, `vps-ssh.sh`,
  runners de cassettes payants, `docker compose -p langfuse-local` (donc `down -v`) ;
- le fichier grossit par « toujours autoriser » ponctuels : commandes figées à usage unique,
  scripts disparus, règles d'un autre projet, chemins relatifs valables dans tout dépôt.

Côté Claude, le même problème est compensé par de la prose : règles 24 à 50 de
`~/.claude/CLAUDE.md` et un hook normaliseur. Aucun des deux agents ne sait où ranger une
nouvelle autorisation.

## 2. Décisions actées avec le user (2026-09-19)

1. Une source unique de politique, traduite pour Claude **et** Codex ; jamais d'édition manuelle
   des fichiers propres à un outil.
2. Portée : un socle global commun à tous les dépôts, plus une couche par dépôt initialisée par
   une commande système identique pour tout nouveau dépôt.
3. Trois niveaux : `allow`, `prompt`, `forbidden`, attribués par critère mécanique.
4. Réutiliser la taxonomie de risque du harness Mastra (`harness/src/codingSandboxCommands.ts`)
   plutôt que d'en inventer une seconde.
5. Après bascule, nettoyer `~/.claude/CLAUDE.md` et son équivalent Codex des consignes devenues
   inutiles.

## 3. Faits vérifiés

- Codex charge `~/.codex/rules/` **et** `<dépôt>/.codex/rules/` quand le projet est de confiance ;
  plusieurs fichiers sont admis ; la décision la plus stricte l'emporte
  (`forbidden` > `prompt` > `allow`) ; `codex execpolicy check --rules <fichier> -- <commande>`
  teste une règle. Source : documentation Codex « Rules », lue le 2026-09-19.
- Claude Code offre les deux mêmes étages (`~/.claude/settings.json`,
  `<dépôt>/.claude/settings.json`) avec `permissions.allow` / `ask` / `deny`, `deny` prioritaire.
  La correspondance est donc directe : `allow`→`allow`, `prompt`→`ask`, `forbidden`→`deny`.
- Le harness porte déjà un contrat neutre `AgentPermissions` traduit par adaptateur
  (`adapters/adapterPolicy.spec.ts`) et une politique souveraine `authorizeSandboxCommand` à
  vocabulaire de refus fermé, où un refus l'emporte toujours sur l'allowlist.
- La branche `chore/agent-permission-hardening` traite la frontière d'écriture (déjà sur `main`),
  pas la politique de commandes : aucun recouvrement.

## 4. Architecture cible

```
socle global (outil système)          couche dépôt (versionnée dans chaque dépôt)
  core-policy.json                       agent-policy/policy.json
        │                                        │
        ├─► ~/.codex/rules/00-core.rules         ├─► .codex/rules/project.rules
        └─► ~/.claude/settings.json              ├─► .claude/settings.json (bloc permissions)
            (bloc permissions)                   └─► listes de refus lues par le harness Mastra
```

- **Socle global** : ce qui est vrai partout — git, gh, rm, interpréteurs génériques, docker
  générique, lectures sûres. Aucun chemin relatif.
- **Couche dépôt** : les points d'entrée du projet (scripts npm nommés, `scripts/*.sh`). Versionnée,
  donc héritée par chaque worktree, et sans effet dans un autre dépôt.
- **Format source** : JSON validé par schéma. Chaque entrée porte `pattern`, `decision`,
  `riskClass` (vocabulaire Mastra : `destructive-program`, `remote-publication`,
  `cloud-mutation`, plus `paid-provider`, `shared-local-state`, `arbitrary-execution`),
  `justification`, `match[]`, `notMatch[]`.
- **Outil système** `agent-policy` : `init` (crée la structure dans un dépôt), `build` (génère),
  `check` (synchronisation + exemples), `install` (écrit le socle global après sauvegarde, diff
  affiché et confirmation).

### Critère d'attribution des niveaux

| Niveau | Critère | Exemples |
|---|---|---|
| `allow` | Lecture seule ou effet local réversible ; aucun argument libre exécutable ; aucun secret chargé ; aucun coût | scripts npm de test nommés, `git status/diff/log/add/commit`, `lsof` lecture |
| `prompt` | Visible de l'extérieur, irréversible, payant ou état partagé | `git push`, `gh pr merge`, `gh workflow run`, `gh variable set`, cassettes payantes, `vps-ssh.sh`, `db-reset-local.sh`, `docker compose down` |
| `forbidden` | Interpréteur générique ou wrapper à commande libre | `npx tsx <libre>`, `with-env.sh <libre>`, `bash -c`, `rm`, `psql` |

Principe de réduction des demandes : une intention récurrente = un point d'entrée fermé sans
argument libre, autorisé nommément. Pour le niveau `prompt`, la garde vit aussi dans le wrapper
(digest, confirmation exacte) : elle tient quel que soit l'agent et même si `package.json` change.

## 5. Plan

1. **Outil système `agent-policy`** — schéma de politique, générateurs Codex et Claude, `check`,
   `init`, `install` avec sauvegarde et confirmation. (DoD 1, 2, 6)
2. **Socle global** — rédiger `core-policy.json` à partir de l'audit, l'installer à la place de
   `default.rules` et du bloc `permissions` global de Claude. (DoD 1, 3, 4)
5. **Nettoyage des consignes compensatoires** — `~/.claude/CLAUDE.md` (règles 24 à 50 devenues
   inutiles), équivalent Codex, helpers périmés de `~/.local/libexec/coproos/`. (DoD 8)
6. **Initialisation d'un second dépôt** par `agent-policy init`, preuve de la commande système. (DoD 6)
7. **Prompt de délégation produit par une commande commune** — commande `agent-policy brief` :
   l'orchestrateur remplit un brief structuré, la commande rend l'en-tête et le bloc à copier au
   format validé le 2026-09-20 ; une phrase dans `AGENTS.md` la rend obligatoire. (DoD 9)
8. **Frontière d'écriture commune** — init dépose dans chaque dépôt un garde-fou qui refuse à
   Claude toute écriture hors du worktree actif, et le déclare dans .claude/settings.json ; repris
   de CoproOS scripts/claude-worktree-write-guard.cjs et de ses tests. Codex n'en reçoit pas : son
   sandbox workspace-write pose déjà cette frontière. (DoD 10)
9. **Lectures Git Codex et précision du rejeu** — autoriser côté Codex `git status`, `diff`,
   `log`, `show`, `rev-parse`, `ls-files`, `grep`, `worktree list` et `merge-tree`, miroirs RTK
   compris, pour les composés mêlant lectures et commandes hors sandbox. Documenter les risques
   acceptés `--ext-diff`, `--output` et `git grep -O` / `--open-files-in-pager` ; aucune règle
   Codex pour `git branch --list`, qui peut être annulé par `--no-list` avant une suppression.
   Le rejeu retire les redirections bénignes `2>&1`, `2>/dev/null`, `>/dev/null`, `&>/dev/null`
   avant d’évaluer chaque segment, et ventile les commandes non analysées par cause : redirection
   vers fichier, substitution, structure shell, heredoc. Aucun retrait d’allow Codex de main,
   aucune règle Codex pour sed, awk ni uniq. (DoD 11, 12, 13)
10. **Parité Git et familles du rejeu** — autoriser `git -C <chemin> add`, `commit` et `fetch`
    côté Claude comme leurs formes sans `-C`, gardes d’options libres comprises. `git fetch`
    devient allow pour les deux moteurs ; Claude demande un accord pour `--upload-pack` et
    `-c`, tandis que Codex accepte le risque `--upload-pack` non filtrable par préfixe.
    Aucune règle Codex pour `git -C`. Les éditeurs et programmes de signature configurés par
    le user restent de confiance, avec un `residualRisk` explicite. `git worktree add` conserve
    son allow Codex et demande un accord côté Claude. Élargir les familles fixes du rejeu à
    sleep, kill, open, curl, bash, sh, chmod, mv, tee, xargs, time, brew, docker, supabase et psql ;
    les chemins `./scripts/` et `scripts/` deviennent « script du dépôt », sans nom libre.
    La parité du critère 14 porte sur les trois formes confiées côté Claude ; l’accord du
    critère 15 sur `--upload-pack` concerne Claude, selon l’arbitrage explicite du user.
    Aucun retrait d’allow Codex de main. (DoD 14, 15, 16)
11. **Compatibilité des classes de risque avec les consommateurs** — classer `env` en
    `arbitrary-execution`, car `env <commande>` exécute un programme, sans changer sa décision.
    Refuser dans `validatePolicy` et dans le schéma toute entrée `prompt` ou `forbidden`
    portant `read-only` ou `local-reversible`, et toute entrée `allow` portant une classe de
    refus. Conserver toutes les décisions du socle. (DoD 17, 18)

### Format de délégation visé par l'item 7

Hors bloc : `Modèle : <modèle> · Effort : <effort> · Thread : <chantier>, nouveau | continuer`.
Dans le bloc, dans cet ordre : worktree et branche ; lectures préalables ; item confié mot pour
mot ; critères de DoD associés mot pour mot ; fichiers autorisés ; frontières ; validations
attendues ; livraison (PR vers `main`, sans merger, `docs/TRACKS.md` à jour) ; condition d'arrêt.

### Base de réutilisation de l'item 7 (scan des branches du 2026-09-20)

Partir de `feat/local-agent-orchestrator-mvp`, non fusionnée, plutôt que d'un schéma neuf :

- `scripts/lib/localAgentOrchestrator/contracts.ts` — `missionBriefSchema`, `planStepSchema`,
  `dodCriterionSchema`, `ownedPathsSchema`, `validationSchema` : chaque étape référence ses critères
  de DoD et ses validations par identifiant, ce qui rend le « mot pour mot » vérifiable.
- `prompt.ts` (`buildRoundPrompt`) et `prompt-scope.spec.ts` — rendu français par rubriques et test
  de périmètre. À compléter : en-tête, lectures préalables, livraison, condition d'arrêt ; phrases à
  réécrire, la branche visant le sens Codex → Opus.
- `policy.ts` — reprendre `assertOwnedPathsSafe` pour la rubrique « fichiers autorisés ». Le
  principe de `assertValidationAllowed` borne la rubrique « validations », mais son `npx tsx` libre
  et son filtrage par sous-chaîne sont plus faibles que le schéma d'`agent-policy` : ne pas reprendre
  le code.

Le contrat `agentTaskSchema` du harness reste la cible du rendu côté Mastra : le brief s'y projette
(`instruction`, `successCriteria`, `expectedModel`, `reasoningEffort`), sans second schéma de tâche.

## 6. DoD

1. Une même entrée de politique produit la règle Codex et la permission Claude équivalentes.
2. Les fichiers générés ne sont jamais édités à la main : un écart avec la source fait échouer le contrôle.
3. Un cycle de travail courant (tsc, tests ciblés, gate, git local, création de worktree, rapport
   Playwright) s'exécute sans aucune demande d'autorisation, sous Claude comme sous Codex.
4. Toute action visible de l'extérieur, irréversible, payante ou sur état partagé déclenche une
   demande d'accord sous les deux agents.
6. Une commande système unique initialise la même structure dans un nouveau dépôt.
8. Les consignes en prose rendues inutiles sont retirées de `~/.claude/CLAUDE.md` et de
   l'équivalent Codex.
9. Un prompt de délégation a la même forme quel que soit l'orchestrateur, et reprend l'item et la
   DoD du plan à l'identique ; une reformulation fait échouer la commande.
10. Dans un dépôt initialisé, Claude ne peut créer, modifier ni supprimer aucun fichier hors de son
    worktree, et le README documente la limite connue : une commande autorisée côté Codex
    s'exécute hors sandbox.
11. Le composé « rg --files … && git diff --check && lsof -ti :3001 » est allow pour Codex, segment
    par segment.
12. Une commande suivie d'une redirection bénigne reçoit le verdict de la commande seule ; une
    redirection vers un fichier reste non analysée.
13. Le rejeu n'affiche toujours aucun argument ni commande intégrale.
14. Une commande git reçoit la même décision avec ou sans -C, pour les deux moteurs concernés.
15. git fetch ne demande plus d'accord ; git fetch --upload-pack=<programme> en demande un.
16. Le rejeu classe sous une famille nommée toute commande dont le programme appartient au
    vocabulaire fixe, et n'affiche toujours aucun argument ni commande intégrale.
17. Toute entrée prompt ou forbidden du socle porte une des six classes de refus.
18. Une politique qui enfreint cette règle est refusée à la validation, avant toute écriture.

## 7. Décisions d'outillage (actées le 2026-09-19) et limite connue

- **Emplacement de l'outil.** Dépôt GitHub dédié `agent-policy`, hors CoproOS, installé une fois
  par machine ; c'est lui qui fournit la commande système. Conséquence : la frontière d'écriture
  d'`AGENTS.md` interdit à une session CoproOS d'y écrire ; les items 1, 2 et 5 se font depuis une
  session ouverte dans ce dépôt, et `install` reste une commande lancée par le user.
- **Dépôt de projet autonome.** `agent-policy init` dépose dans le dépôt de projet un générateur
  mono-fichier sans dépendance, avec en-tête de version, rafraîchi par `init --upgrade`. La gate
  du projet exécute cette copie : elle tourne hors ligne, sur GitHub comme sur une machine sans
  l'outil global, et tout ce qui produit son verdict appartient au SHA testé.
- **Limite connue côté Claude.** Pas d'équivalent officiel à `codex execpolicy check` : les
  exemples `match`/`notMatch` sont vérifiés côté Claude par le matcher du générateur, pas par
  l'outil lui-même.

## 8. Hors périmètre

- Le hook normaliseur global de Claude et `scripts/claude-worktree-write-guard.cjs` restent en place.
- Le mécanisme d'allowlist exacte par plan du harness n'est pas modifié ; seules ses listes de
  refus changent de source.
- Aucune modification de `~/.codex` ou `~/.claude` avant l'item 2, qui commence par une sauvegarde.
