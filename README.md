# agent-policy

Une source JSON traduit les décisions de commandes pour **Codex et Claude Code**.
Le socle global est dans [`core-policy.json`](core-policy.json) ; chaque dépôt garde
sa propre couche, une copie autonome du générateur et une commande de brief. Node.js ≥ 22, aucune dépendance
d’exécution ou de test, JavaScript sans casts. Les échanges et la documentation sont en français.

## Installer l’outil sur chaque machine

Depuis un checkout de cette PR, puis de la version relue et fusionnée :

```sh
npm test
mkdir -p .agent-tmp
npm pack --pack-destination .agent-tmp
npm install --global --ignore-scripts ./.agent-tmp/souroucheb-agent-policy-1.2.0.tgz
agent-policy --help
```

Le tarball installe une copie de la version relue, indépendante des changements ultérieurs du
checkout. Une installation depuis Git peut aussi être épinglée à un SHA :
`npm install --global --ignore-scripts 'git+https://github.com/SouroucheB/agent-policy.git#<SHA>'`.
Aucune étape npm n’applique le socle aux agents. Aucun `postinstall` n’est présent.

**Ordre conseillé : préparer les couches des dépôts avant le socle global.** Dans chaque dépôt,
exécuter `agent-policy init` (ou `init --upgrade` si le générateur est déjà présent), renseigner
`agent-policy/policy.json`, puis exécuter `agent-policy build` et `agent-policy check`.
Cette préparation doit précéder `install`, qui archive `default.rules` et retire donc aussi
les anciennes autorisations de scripts de projet qu’il contenait.

**À lancer personnellement**, après lecture du diff :

```sh
agent-policy install
```

L’outil vise les emplacements standards de la machine, indépendamment des éventuelles variables
de personnalisation des agents :

- `~/.codex/rules/00-core.rules` ;
- les entrées `Bash(...)` de `permissions.allow`, `permissions.ask` et `permissions.deny` dans
  `~/.claude/settings.json` ; toutes les permissions non-Bash et les autres clés sont conservées ;
- l’ancien `~/.codex/rules/default.rules`, **archivé puis retiré du dossier actif** s’il existe.

Laisser `default.rules` actif conserverait ses anciennes autorisations larges. Les autres fichiers
`.rules`, les réglages Claude locaux/administrés et les hooks restent à la charge de leur propriétaire :
cette installation ne prétend pas nettoyer toute la configuration de la machine.

`install` valide les sources et les cibles, affiche le diff, puis exige la ligne exacte
`INSTALLER /chemin/absolu/de/la/racine`. Ni `oui`, ni Entrée, ni EOF, ni `--yes` ne valent confirmation.
Il sauvegarde ensuite les fichiers **avant** de les remplacer. Une modification des cibles pendant
la confirmation invalide l’opération. Les liens symboliques sont refusés. Une erreur d’écriture
déclenche une restauration ; une interruption brutale nécessite le retour arrière ci-dessous.
Une installation déjà synchronisée est sans effet.

Pour une simulation isolée, toutes les cibles, y compris les sauvegardes, sont sous la racine choisie :

```sh
mkdir -p .agent-tmp/install-demo
agent-policy install --target-root "$PWD/.agent-tmp/install-demo"
```

Les tests n’exécutent jamais une installation réelle. Ils ne lisent aucun fichier `.env` et créent
leurs artefacts uniquement dans `.agent-tmp/` du checkout.

## Sauvegardes et retour arrière

Les sauvegardes sont dans `~/.agent-policy/backups/<date-UTC>-<identifiant>/`, ou
`<target-root>/.agent-policy/backups/…` pour une simulation. Ce dossier privé contient les copies
aux mêmes chemins relatifs et `manifest.json` : présence antérieure, mode Unix et SHA-256.
Les copies sont privées (`0600`), le dossier `0700`. Conserver ce dossier hors du dépôt.

Pour revenir en arrière, arrêter les agents, choisir la sauvegarde affichée par `install`, puis,
pour **chacun des trois chemins exacts** du manifeste :

1. Si `existed` vaut `true`, recopier le fichier depuis la sauvegarde vers `targetRoot/path`,
   puis rétablir le mode Unix indiqué par `mode` (valeur décimale dans le JSON).
2. Si `existed` vaut `false`, supprimer seulement ce fichier cible s’il existe.
3. Redémarrer Codex et Claude Code.

Cela restaure aussi `default.rules` et l’intégralité des anciens réglages Claude. Toute modification
apportée aux réglages après l’installation doit être conservée séparément avant cette restauration.
Les tests vérifient ce retour arrière, y compris le cas de fichiers initialement absents.

## Initialiser un dépôt

Exécuter à la racine du dépôt concerné :

```sh
agent-policy init
# Modifier agent-policy/policy.json, puis :
agent-policy build
agent-policy check
```

Structure à versionner dans le projet :

```text
agent-policy/policy.json              # source du dépôt, vide mais valide à l'initialisation
scripts/agent-policy/generate.mjs     # copie autonome avec en-tête de version
scripts/agent-policy/brief.mjs        # commande de brief autonome avec en-tête de version
.codex/rules/project.rules           # sortie générée
.claude/settings.json                # entrées Bash générées ; autres permissions et clés conservées
```

`init` conserve les fichiers existants et ajoute les copies absentes. `agent-policy init --upgrade`
rafraîchit le générateur et la commande `brief` depuis l’outil installé, sans modifier un octet de `policy.json`.
Ces deux commandes sont idempotentes. Une source existante invalide fait échouer l’opération.

La gate du projet appelle sa **copie versionnée**, sans outil global, paquet à télécharger ni réseau :

```sh
node scripts/agent-policy/generate.mjs check
```

Pour régénérer avec cette même copie : `node scripts/agent-policy/generate.mjs build`.
`check` reconstruit les sorties en mémoire, compare les fichiers et vérifie les exemples des deux
moteurs. Une édition manuelle des règles Codex ou des entrées Bash générées fait échouer le contrôle.
Le générateur possède **uniquement les entrées `Bash(...)`** des listes `allow`, `ask` et `deny` :
les anciennes entrées Bash sont remplacées par celles de la politique. Les entrées `Read`, `Write`,
`Edit`, `mcp__…` et toutes les autres permissions non-Bash sont conservées dans leur ordre existant,
y compris dans `deny`. Les autres clés de `permissions`, comme `defaultMode` et
`additionalDirectories`, ainsi que les hooks et les autres réglages restent également inchangés.

`build` et `install` appliquent cette même règle de conservation, sans reformater le reste du
document. Ajouter une permission non-Bash à la main, modifier un réglage non possédé ou reformater
`settings.json` laisse `check` vert tant que les entrées Bash générées restent conformes.
Une post-condition compare les permissions non-Bash, les autres valeurs et leur ordre avec
l’entrée, puis les listes Bash avec la politique. Tout écart fait échouer la commande avant
l’écriture des fichiers, y compris pendant une installation.

`check --codex` ajoute, si `codex` est installé, un contrôle natif de chaque commande d’exemple
avec `codex execpolicy check`. Il n’exécute pas ces commandes. Codex absent n’est pas un échec ;
un binaire présent qui échoue ou donne un verdict différent l’est. Ce contrôle reste hors ligne
et isole l’état éventuel du processus Codex dans `.agent-tmp/`, ensuite nettoyé.

## Produire un brief de délégation

Depuis la racine du dépôt contenant le plan et le brief :

```sh
agent-policy brief brief.json
# Même rendu hors ligne, sans outil global :
node scripts/agent-policy/brief.mjs brief.json
```

La sortie standard contient uniquement l’en-tête
`Modèle : <modèle> · Effort : <effort> · Thread : <chantier>, nouveau | continuer`,
puis un bloc de code. `thread.mode` choisit **un seul** des deux états. Dans ce bloc : worktree
et branche, lectures préalables, item confié, critères de DoD associés, fichiers autorisés,
frontières, validations attendues, livraison, condition d’arrêt. Le plan est toujours la première
lecture ; les autres lectures sont reproduites sans être ouvertes. Les noms de modèle et d’effort
sont des textes explicites du brief, indépendants du fournisseur et de l’orchestrateur.

Le [plan repris dans ce dépôt](docs/plans/2026-09-20-001-agent-policy-plan.md) fournit cet exemple
complet. Adapter le worktree et les rubriques de mission avant usage. Le SHA-256 ci-dessous est
celui de cette version du plan ; pour un autre plan, calculer son empreinte avec
`shasum -a 256 docs/plans/<plan>.md` et copier ses passages exacts dans le JSON.

```json
{
  "schemaVersion": 1,
  "model": "modele-exemple",
  "effort": "high",
  "thread": { "workstream": "agent-policy", "mode": "nouveau" },
  "worktree": "/chemin/du/depot/agent-policy",
  "branch": "feat/agent-policy-brief",
  "plan": {
    "path": "docs/plans/2026-09-20-001-agent-policy-plan.md",
    "sha256": "ce215f1e7b4194f57b14fcc8c0de0169312bde898ab32f52a3c9e46fee977ac7",
    "itemSection": "## 5. Plan",
    "dodSection": "## 6. DoD"
  },
  "prerequisiteReads": ["README.md"],
  "planStep": {
    "id": "7",
    "text": "7. **Prompt de délégation produit par une commande commune** — commande `agent-policy brief` :\n   l'orchestrateur remplit un brief structuré, la commande rend l'en-tête et le bloc à copier au\n   format validé le 2026-09-20 ; une phrase dans `AGENTS.md` la rend obligatoire. (DoD 9)",
    "dodCriterionIds": ["9"],
    "validationIds": ["tests"]
  },
  "dod": [
    {
      "id": "9",
      "text": "9. Un prompt de délégation a la même forme quel que soit l'orchestrateur, et reprend l'item et la\n   DoD du plan à l'identique ; une reformulation fait échouer la commande."
    }
  ],
  "ownedPaths": ["bin/**", "lib/**", "test/**", "README.md", "package.json"],
  "boundaries": [
    "Écriture limitée à ce dépôt ; aucun cast ; aucune lecture de .env.",
    "Aucun install réel ; aucune modification de ~/.codex, ~/.claude ni de CoproOS."
  ],
  "validations": [
    { "id": "tests", "label": "Tests hors ligne", "command": ["npm", "test"], "timeoutMs": 90000 }
  ],
  "delivery": ["PR vers main, sans merger ; rapport avec SHA et nombre de tests."],
  "stopCondition": "Arrêter et demander si une rubrique du brief est ambiguë."
}
```

Tous ces champs sont requis ; les champs inconnus, doublons et références absentes sont refusés.
`prerequisiteReads` peut être vide puisque le plan est ajouté automatiquement. Les autres listes
doivent être non vides. `delivery` décrit la livraison propre à la mission, y compris les documents
à mettre à jour si nécessaire. `stopCondition` contient les conditions explicites d’arrêt.
Le worktree est un chemin absolu affiché, qui peut désigner un futur worktree ; il n’est pas ouvert.
Les deux fichiers lus, brief JSON et plan Markdown, sont résolus depuis le répertoire courant.
Ils doivent rester dans ce dépôt, sans lien symbolique, chemin `.git` ou `.env*`.

Le plan est un fichier UTF-8 sous `docs/plans/`, avec fins de ligne LF. Les deux titres `##`
référencés sont uniques. Les passages sont des items numérotés `7. …` en colonne 1, dont les
suites sont indentées d’au moins trois espaces (ou une tabulation). Chaque item se termine par
son association explicite, par exemple `(DoD 1, 2, 6)`. Les exemples à l’intérieur d’un bloc de
code ne comptent pas comme des items. Un doublon d’identifiant ou de titre est refusé.

`text` reprend **le passage complet**, numéro, ponctuation, espaces et retours à la ligne compris,
sans les lignes vides qui le séparent du passage suivant. Aucun `trim`, résumé ou reformulation
n’est appliqué. Le contrôle vérifie l’empreinte du plan, l’item exact et chacun de ses critères
exacts ; une simple sous-chaîne ne suffit pas. `dodCriterionIds` doit reprendre tous les critères
associés dans l’ordre du plan. `validationIds` fixe les validations et leur ordre ; les définitions
`dod` et `validations` doivent correspondre exactement à ces références. Une erreur écrit un
diagnostic sur stderr, renvoie un code non nul et ne produit aucun brief partiel.

Le contrat reprend sans Zod les principes de `missionBriefSchema`, `planStepSchema`,
`dodCriterionSchema`, `ownedPathsSchema` et `validationSchema` de la branche CoproOS
`feat/local-agent-orchestrator-mvp` : référence de plan avec empreinte, identifiants liés,
commandes en argv (1 à 30 arguments), délai de 1 000 à 900 000 ms. Le texte intégral remplace
les résumés `title` / `expectedOutcome` / `label` pour l’item et la DoD. Les rubriques françaises
reprennent `prompt.ts`, en retirant ses restrictions propres à un fournisseur.

La vérification des fichiers autorisés reprend `assertOwnedPathsSafe` et refuse les chemins
absolus (POSIX et Windows), antislashs, `..`, segments vides ou `.`, ainsi que les segments
`.git` et `.env*`, même imbriqués. Les motifs comme `lib/**` restent possibles ; ils déclarent
un périmètre, sans remplacer la frontière d’écriture de l’agent. La commande affiche les argv
des validations en protégeant leurs arguments shell ; elle ne les exécute pas et ne leur accorde
aucune permission. Elle ne reprend pas l’allowlist libre `npx tsx` du prototype CoproOS.

## Écrire une entrée

Le [schéma JSON](policy.schema.json) et la validation runtime refusent les champs inconnus,
les doublons, les décisions/risques invalides et plusieurs formes connues d’interpréteurs ou
wrappers libres en `allow`. Une politique a la forme suivante :

```json
{
  "version": 1,
  "entries": [
    {
      "pattern": ["gh", "pr", "merge"],
      "decision": "prompt",
      "riskClass": "remote-publication",
      "justification": "La fusion d’une PR appartient au user",
      "match": ["gh pr merge 12 --squash"],
      "notMatch": ["gh pr view 12"]
    }
  ]
}
```

Chaque entrée exige au moins un `match` et un `notMatch`. `pattern` est un préfixe **d’arguments
littéraux**, sans joker, espace interne ni code shell. Les exemples sont des commandes simples,
sans pipeline, expansion, redirection ou affectation. Les guillemets des arguments suffixes sont
acceptés. Les mots du préfixe sont écrits sous leur forme canonique commune aux deux moteurs.
Un exemple dont la représentation textuelle Claude et les arguments Codex divergent est refusé
s’il cible les deux moteurs. Chaque exemple est vérifié uniquement contre les moteurs de son entrée.

Exception pour un refus inexprimable en préfixe Codex : une entrée `forbidden` peut omettre
`pattern`, `match` et `notMatch`, à condition de fournir `residualRisk` et `claudeDeny` avec ses
exemples. Elle ne génère aucune règle Codex fictive. Les exemples des gardes Claude sont du texte
inerte et peuvent contenir un heredoc ; ils ne sont jamais exécutés. Le matcher textuel des gardes
ne remplace pas l’analyse shell propre à Claude.

`notMatch` est une **assertion de test**, jamais une exclusion. Ainsi, `rm -rf a b autre` correspond
bien au préfixe `rm -rf a b` ; le mettre dans `notMatch` est une erreur détectée avant génération.
Le socle interdit `rm` entier et n’accorde aucune règle `gh pr` générale.

| Source | Codex | Claude |
| --- | --- | --- |
| `allow` | `allow` | `permissions.allow` |
| `prompt` | `prompt` | `permissions.ask` |
| `forbidden` | `forbidden` | `permissions.deny` |

## Cibler les moteurs et conserver RTK

Le champ optionnel `engines` d’une **entrée** est un sous-ensemble non vide, sans doublon, de
`["codex", "claude"]`. Son absence cible les deux moteurs. Une entrée `engines: ["claude"]`
n’ajoute aucune règle ni exemple au fichier Codex ; l’inverse vaut pour `["codex"]`. Les gardes
`claudeDeny` ne sont générées et testées que si Claude est ciblé. La validation structurelle du
JSON reste commune. Un même motif peut avoir deux entrées si leurs moteurs sont disjoints ; un
doublon sur le même moteur est refusé. Le contrôle natif `check --codex` ne reçoit que les exemples
Codex, y compris ceux des miroirs.

`commandPrefixes` est une option à la **racine de la politique**, indépendante de `engines` :

```json
{
  "version": 1,
  "commandPrefixes": [["rtk"], ["rtk", "proxy"]],
  "entries": [
    {
      "pattern": ["git", "status"],
      "decision": "allow",
      "riskClass": "read-only",
      "justification": "Lecture de l’état du dépôt",
      "match": ["git status --short"],
      "notMatch": ["git push origin main"]
    }
  ]
}
```

La forme directe est conservée. Chaque préfixe argv est ajouté **une seule fois** au motif, aux
exemples `match`/`notMatch`, et aux motifs et exemples des gardes Claude. La décision et les moteurs
cibles ne changent pas. Les gardes sans motif argv (heredocs, exécutables absolus, etc.) sont aussi
miroitées dans Claude. Elles n’inventent aucune règle Codex. Les préfixes sont littéraux, non vides,
sans doublon ; `commandPrefixes` absent ou vide signifie aucun miroir. Cette option décrit un
wrapper de confiance qui transmet les arguments ; elle ne lui accorde aucune permission seule.
Les mêmes contrôles d’allow s’appliquent aux entrées dérivées.

| Commande | Codex | Claude |
| --- | --- | --- |
| `rtk git status` | allow | allow |
| `rtk git push origin main` | prompt | ask |
| `rtk proxy rm file` | forbidden | deny |
| `rtk rg needle src` | prompt | allow |
| `rtk proxy cat README.md` | aucune règle du socle | allow |
| `rtk proxy cat .env` | aucune règle du socle | deny |

Le socle déclare les deux préfixes ci-dessus. Une couche de dépôt peut les déclarer de la même
façon pour ses propres scripts. Les règles propres `rtk grep`, `rtk read`, `rtk ls`, `rtk diff`,
`rtk gain`, `rtk discover` et `rtk session` sont autorisées sur les deux moteurs. Leurs formes
préfixées sont également générées, sans expansion récursive. Les collisions de même motif et
décision sont dédupliquées dans les sorties (exemples Codex réunis) ; des décisions différentes
restent soumises à la priorité habituelle. Aucun `rtk` ou `rtk proxy` libre n’est autorisé.

La génération teste la politique, sans exécuter RTK ni les commandes d’exemple. Elle ne garantit
pas qu’une version de RTK accepte toutes les formes : par exemple, `rtk proxy <commande>` sert à
transmettre une commande non prise en charge nativement. RTK 0.45.0 a été inspecté avec son aide
locale : `grep` transmet des options de recherche à ripgrep, `read` accepte plusieurs fichiers,
et `diff` compare des fichiers. Les statistiques RTK peuvent écrire leur état local réversible.
La configuration et les filtres RTK doivent être de confiance.

## Lectures Claude et gardes

Le socle autorise pour **Claude uniquement** : `ls`, `cat`, `head`, `tail`, `grep`, `wc`, `sort`,
`rg`, `sed -n`, `echo`, `printf`, `pgrep`, `xxd`, `dig`, `pbpaste` et `which`. Ces règles évitent une
demande Bash à chaque lecture. Elles ne modifient pas les permissions de lecture dans le sandbox
Codex ; `rg` et `sed` restent en `prompt` côté Codex, ainsi que leurs miroirs.

Les entrées allow de `cat`, `head`, `tail`, `grep`, `rg` et `sed` ciblant Claude exigent la garde
canonique `<commande> *.env*`. `rg` exige aussi `rg *--pre*`. L’exception à l’interdiction de
`rg`/`sed` en allow exige exactement `engines: ["claude"]`, `riskClass: "read-only"` et ces gardes.
Pour `sed`, seul le préfixe `sed -n` est accepté ; les gardes `sed *-i*` et `sed *--in-place*`
conservent les refus d’écriture en place. `grep` porte aussi une garde `--pre`, utile à son miroir
`rtk grep`, qui transmet les options à ripgrep.

Le miroir reproduit automatiquement ces gardes sous `rtk` et `rtk proxy`. Les commandes propres
`rtk read`, `rtk grep` et `rtk diff` portent elles aussi les gardes `.env*`, et `rtk grep` la garde
`--pre`. La forme `rtk grep --pre <programme>` a en plus un préfixe interdit pour les deux moteurs.
Un refus Claude est prioritaire sur une permission allow, y compris dans un autre motif.

Ces gardes portent sur le **texte de commande** : `.env*` vise les chemins explicites, y compris
relatifs, absolus et cités, mais peut aussi refuser une recherche où `.env` est le motif. Elles
ne résolvent pas les liens symboliques, chemins échappés, expansions shell, listes de fichiers
indirectes ou parcours récursifs implicites. Elles ne constituent pas un contrôle des fichiers
effectivement ouverts. La frontière d’écriture et les protections de l’agent restent nécessaires.
`read-only` décrit l’usage demandé : les arguments libres de `sort` (`-o`, `--compress-program`),
`xxd` (sortie, `-r`) ou le programme de `sed -n` (instructions `e`/`w`) peuvent changer ses effets.
Ces limites sont explicitées dans `residualRisk` et ne sont pas masquées par le générateur.

`lsof -i`, `lsof -ti` et `lsof -nP` sont autorisés pour les deux moteurs et leurs miroirs. La
règle générale `lsof` en prompt est retirée, car elle masquerait ces allow. Le préfixe `lsof -D`
reste en prompt et une garde Claude refuse `-D` à toute position. Les valeurs collées comme
`lsof -i:3000` / `-ti:3000` ne correspondent pas aux tokens `-i` / `-ti` : elles ne sont pas
autorisées par le préfixe Codex. Utiliser les formes à tokens séparés, ou `lsof -nP -iTCP:3000`.

Limites Codex du miroir, identiques sous `rtk` et `rtk proxy` :

| Formes | Limite |
| --- | --- |
| Lectures `.env*`, dont `rtk read` / `rtk grep` / `rtk diff` | Aucun filtrage des noms de fichiers par un préfixe argv. Les gardes de chemins sont propres à Claude ; les entrées Claude seules restent absentes de Codex. |
| `npm audit … fix`, `git fetch … --upload-pack`, `rg … --pre`, `sed … -i/--in-place` | Impossible de filtrer une option en position libre ; `fetch`, `rg` et `sed` restent en prompt Codex. |
| `rtk grep … --pre` ou `--pre=commande` | Le sous-préfixe exact `rtk grep --pre` est interdit ; les autres positions et valeurs collées échappent à ce préfixe Codex. |
| `lsof … -D…`, `lsof -i:…`, `lsof -ti:…` | Options en position libre ou valeurs collées ; les formes `-i` / `-ti` / `-nP` autorisent encore des arguments suivants, même `-D`, côté Codex. |
| `find … -delete/-exec`, `perl -pi*` / `-i*` | Position libre ou suffixe dans un token, comme pour les formes directes. |
| Heredocs, `/bin/*`, `/usr/bin/*`, `/usr/local/bin/*`, `/opt/homebrew/bin/*`, `head-*`, `tail-*` | Syntaxe shell ou joker à l’intérieur du token exécutable ; gardes Claude seules. |

La priorité est `forbidden > prompt > allow`. Une permission Claude canonique est
`Bash(gh pr merge:*)`. Un `prompt` général ne permet donc aucune exception `allow` plus précise :
les sous-commandes Docker Compose et Supabase sont énumérées. Une commande nouvelle ou écrite
avec d’autres options initiales reste **sans autorisation du socle**, soumise au comportement des
agents et du sandbox ; cela ne signifie pas automatiquement `forbidden`.

Les risques sont `destructive-program`, `remote-publication`, `cloud-mutation`, `paid-provider`,
`shared-local-state`, `arbitrary-execution`, `read-only`, `local-reversible`.

## Arbitrage des variantes dangereuses

Question par préfixe : **la variante peut-elle nuire seule, sans étape préalable déjà soumise à accord ?**

- Sous-préfixe identifiable : conserver l’autorisation et ajouter une règle plus stricte,
  par exemple `npm audit` en `allow`, `npm audit fix` en `prompt`.
- Configuration préalable nécessaire, ou effet local réversible accepté : expliquer la limite
  dans le champ optionnel `residualRisk`. `npx tsc --noEmit false` reste ainsi autorisé.
- Option libre suffisante pour exécuter une commande ou écrire hors dépôt : aucun `allow`
  générique Codex pour `rg`, `sed` et `git fetch`. L’exception Claude demandée pour `rg` et
  `sed -n` est bornée aux moteurs et gardes décrits ci-dessus.

Les gardes supplémentaires Claude se déclarent dans la **même source**, avec leurs propres tests :

```json
"claudeDeny": [
  {
    "pattern": "git fetch *--upload-pack*",
    "match": ["git fetch origin --upload-pack=custom-command"],
    "notMatch": ["git fetch --prune origin"]
  }
]
```

Ce champ optionnel ajoute seulement des `deny` lorsque Claude est ciblé. Il ne peut jamais
assouplir la décision de l’entrée pour ce moteur.
Les jokers sont des correspondances textuelles, potentiellement plus restrictives, sans analyse
exhaustive des options combinées. Le générateur ne prétend pas inspecter le contenu d’un wrapper.
Un script nommé doit lui-même refuser les arguments libres, le chargement de secrets non prévu et
les contournements ; sa revue fait partie de la PR qui ajoute son autorisation.

Choix explicites du socle après application de ce critère :

| Famille | Choix et limite |
| --- | --- |
| `git diff`, `git log` | Lectures autorisées avec fin des options : `git diff --`, `git diff --cached --`, `git log --`. `--ext-diff` dépendrait d’une configuration préalable, mais `--output` peut à lui seul écrire hors dépôt, d’où cette restriction. |
| Git local | Hooks, filtres et pager existants supposés de confiance ; aucun `git -c …` n’est autorisé globalement. La création de worktree est l’opération locale réversible expressément prévue. |
| `lsof` | Lectures `-i`, `-ti`, `-nP` autorisées explicitement. `-D` reste soumis à accord en préfixe Codex et refusé par garde Claude ; les options suffixes et valeurs collées restent une limite Codex. |
| `npm audit` | `fix` canonique en `prompt`. Codex ne couvre pas `npm audit --json fix` avec ce sous-préfixe ; la limite est dans `residualRisk` et Claude dispose d’un refus supplémentaire. |
| `npx tsc --noEmit` | Compilateur installé et configuration locale de confiance nécessaires ; le préfixe ne vérifie pas leur présence. `npx` peut télécharger un paquet absent. Réactivation de l’émission acceptée comme effet local réversible. |
| `docker compose` | Lectures `ls`, `ps`, `images`, `top` distinguées des mutations. La lecture de configuration/environnement par Compose suppose un projet de confiance, explicitée dans `residualRisk`. |
| `npx supabase status` | `prompt` également, car `-o env` peut exposer les clés locales. |
| `curl` / `wget` | Interdiction conservatrice des commandes entières : un simple préfixe ne sait pas exprimer « seulement lorsqu’il est pipé vers un shell ». Cela bloque la source de ces pipelines ; utiliser un téléchargement contrôlé. |

Le socle n’autorise aucun chemin ni point d’entrée de projet. Ses seuls chemins de refus sont
l’exécutable standard `./node_modules/.bin/tsx` et les quatre familles d’exécutables absolus
ci-dessous. Les deux refus `with-env.sh npx tsx -e` et `with-supabase-env.sh npx tsx -e` restent
dans la couche CoproOS : les tests couvrent 31 refus globaux et ces 2 refus dans une couche simulée.

Les refus ajoutés couvrent aussi les suppressions Docker, l’installation npm globale, `chmod -R
777`, `chown -R`, le code inline Python/Perl/Ruby/PHP/tsx et `nohup`. Limites expressives de Codex,
toutes documentées en `residualRisk` dans la source :

| Refus | Limite du préfixe Codex ; garde Claude conservée |
| --- | --- |
| `find … -delete`, `find … -exec` | Option après un chemin ou en position libre ; seules les formes commençant par `find -delete` / `find -exec` ont aussi un préfixe Codex. |
| `perl -pi*`, `perl -i*` | Suffixe collé au même argument, par exemple `.bak` ; les arguments exacts `-pi` et `-i` ont aussi un préfixe Codex. |
| Heredocs | `cat <<*`, `cat > * <<*`, `cat >> * <<*`, `tee * <<*` portent sur la syntaxe shell, pas sur argv. Les deux anciens motifs de scratchpad sont couverts par `cat > * <<*`. |
| Exécutables absolus | `/bin/*`, `/usr/bin/*`, `/usr/local/bin/*`, `/opt/homebrew/bin/*` exigent un joker dans le token exécutable. |
| Noms erronés | `head-*` et `tail-*` exigent également un joker dans le token exécutable. |

## Où ranger une autorisation ?

1. Un point d’entrée déjà autorisé couvre-t-il le besoin ? L’utiliser.
2. Besoin ponctuel ? Accepter une seule demande, sans persister de règle.
3. Besoin récurrent ? Ajouter dans la même PR un wrapper fermé, l’entrée et ses exemples.
4. La règle est-elle vraie sur toutes les machines et dans tous les dépôts, sans chemin ?
   Elle appartient à `core-policy.json`. Sinon, à `agent-policy/policy.json` du dépôt.
5. Choisir le niveau par le risque : lecture/effet local réversible sans exécution libre, secret
   chargé ou coût → `allow` ; publication, irréversibilité, coût ou état partagé → `prompt` ;
   interpréteur générique ou wrapper libre → `forbidden`. Appliquer l’arbitrage ci-dessus aux variantes.

La politique porte les commandes ; `AGENTS.md` porte ce comportement. Ne pas modifier les sorties
pour résoudre une demande d’autorisation. Les wrappers payants ou destructifs doivent également
porter leur garde interne, indépendamment de l’agent.

## Portée des contrôles et sources

Les règles Codex s’appliquent aux demandes d’exécution **hors sandbox**, et se chargent depuis les
couches de configuration actives. La couche projet nécessite la confiance du dépôt. Elles ne
remplacent ni la frontière d’écriture ni les restrictions réseau.
[Documentation officielle Codex](https://developers.openai.com/codex/rules/).

Claude ne propose pas d’équivalent officiel à `execpolicy check` : ses exemples sont vérifiés par
le matcher du générateur, pas par Claude lui-même. Ce matcher couvre notre grammaire canonique,
pas l’ensemble de sa normalisation de wrappers, guillemets ou commandes composées. Les règles
par préfixe ne sont pas une frontière de sécurité pour toutes les invocations équivalentes
(par exemple chemins absolus, alias, `git -C …`, options regroupées). Garder le sandbox et les hooks.
[Permissions Claude](https://code.claude.com/docs/en/permissions).

Références des arbitrages : [`git diff --output`](https://git-scm.com/docs/git-diff),
[cache `lsof -D`](https://github.com/lsof-org/lsof/blob/master/Lsof.8),
[`npm audit fix`](https://docs.npmjs.com/cli/v11/commands/npm-audit/),
[`supabase status`](https://supabase.com/docs/reference/cli/supabase-status).

## Vérification du dépôt de l’outil

```sh
npm test
```

Les tests `node:test` couvrent le schéma, toutes les entrées et gardes du socle, la priorité des
règles, les pièges de préfixe, les sorties, la préservation des hooks et des permissions non-Bash,
les dérives Bash et les ajouts non-Bash manuels, deux dépôts
autonomes, `init --upgrade`, le contrôle natif optionnel, la confirmation d’installation,
les sauvegardes, le retour arrière, les échecs d’écriture, les 31 refus globaux et les 2 wrappers
simulés (formes directes et RTK), la post-condition Claude, le contrat/rendu exact des briefs,
le ciblage `engines`, les miroirs et les gardes de lecture. Aucun appel fournisseur, aucun
paquet téléchargé et aucune installation globale ne sont nécessaires.
