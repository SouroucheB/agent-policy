# agent-policy

Une source JSON traduit les décisions de commandes pour **Codex et Claude Code**.
Le socle global est dans [`core-policy.json`](core-policy.json) ; chaque dépôt garde
sa propre couche, une copie versionnée du socle, un générateur autonome et une commande de brief. Node.js ≥ 22, aucune dépendance
d’exécution ou de test, JavaScript sans casts. Les échanges et la documentation sont en français.

## Installer l’outil sur chaque machine

Depuis un checkout de cette PR, puis de la version relue et fusionnée :

```sh
npm test
mkdir -p .agent-tmp
npm pack --pack-destination .agent-tmp
npm install --global --ignore-scripts ./.agent-tmp/souroucheb-agent-policy-1.3.0.tgz
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

Le diff retire d’abord les lignes communes au début et à la fin, puis calcule les changements
dans le milieu restant. Si ce milieu dépasse la borne de la LCS (4 000 000 couples de lignes),
un bloc marqué « Diff simplifié » affiche toutes ses lignes retirées, puis toutes ses lignes
ajoutées, sans troncature. Des lignes inchangées à l’intérieur de ce bloc peuvent alors être
réaffichées ; les extrémités communes restent omises. La taille du diff ne bloque pas l’installation.

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
agent-policy/core-policy.json         # copie exacte du socle de l'outil
agent-policy/core-policy.version.json # version de l'outil et SHA-256 de cette copie
scripts/agent-policy/generate.mjs     # copie autonome avec version et socle embarqué
scripts/agent-policy/brief.mjs        # commande de brief autonome avec en-tête de version
scripts/claude-worktree-write-guard.cjs # garde Claude autonome avec en-tête de version
.codex/rules/project.rules           # sortie générée
.claude/settings.json                # hook du garde dès init ; entrées Bash produites par build
```

`init` conserve les fichiers existants et ajoute les copies absentes. `agent-policy init --upgrade`
rafraîchit le socle, sa version, le générateur, la commande `brief` et le garde depuis l’outil installé,
sans modifier un octet de `policy.json`.
Ces deux commandes sont idempotentes. Une source existante invalide fait échouer l’opération.
Le champ `version: 1` des politiques reste la version de leur **format**. Le fichier
`core-policy.version.json` porte la version de livraison du socle (1.3.0) et son empreinte,
sans ajouter de champ ni changer le format de la politique du dépôt.

La gate du projet appelle sa **copie versionnée**, sans outil global, paquet à télécharger ni réseau :

```sh
node scripts/agent-policy/generate.mjs check
```

Pour régénérer avec cette même copie : `node scripts/agent-policy/generate.mjs build`.
`check` reconstruit les sorties en mémoire, compare les fichiers et vérifie les exemples des deux
moteurs. Une édition manuelle des règles Codex ou des entrées Bash générées fait échouer le contrôle.
Il compare aussi, octet pour octet, la copie du socle et son fichier de version avec le socle
embarqué dans ce générateur. Une copie manquante ou modifiée fait échouer `check`, `build` et
l’API de consommation avant toute écriture ; `init --upgrade` la rétablit. `build` continue
de générer uniquement les permissions de la couche du projet. Copier le socle ne l’installe pas
dans les réglages des agents et ne lit pas les réglages personnels de la machine.
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

### Frontière d’écriture Claude (item 8)

`init` dépose `scripts/claude-worktree-write-guard.cjs`, fichier CommonJS autonome sans
dépendance, repris du garde CoproOS. Il déclare dans `.claude/settings.json` ce hook :

```json
{
  "matcher": "Bash|Write|Edit|MultiEdit",
  "hooks": [{
    "type": "command",
    "command": "node \"$CLAUDE_PROJECT_DIR/scripts/claude-worktree-write-guard.cjs\"",
    "timeout": 5
  }]
}
```

Cette déclaration appartient à `hooks.PreToolUse`. Le garde renvoie le code 2 pour bloquer
l’appel, sans jamais exécuter le texte Bash reçu ([contrat des hooks Claude](https://code.claude.com/docs/en/hooks#exit-code-2)).
Node doit être disponible dans le PATH de Claude. Versionner le garde et les réglages avec
les autres fichiers déposés, puis recharger les réglages de Claude avant de travailler.

`init` ne possède que cette déclaration : les autres hooks, leurs options, les permissions,
les autres clés et leur ordre sont conservés, sans reformater leurs valeurs. Une post-condition
vérifie cette conservation et la présence d’un seul garde synchrone sur les quatre outils,
avant toute écriture. Les réglages invalides ou `disableAllHooks: true` font échouer `init`.
`build` conserve ensuite tous les hooks ; il continue de ne posséder que les permissions Bash.

Un dépôt comme CoproOS qui déclare déjà exactement ce garde ne reçoit aucune seconde
déclaration et son `settings.json` reste identique octet pour octet. Les anciennes invocations
relatives `node scripts/claude-worktree-write-guard.cjs` (avec ou sans `./`) et la forme
`${CLAUDE_PROJECT_DIR}` citée sont reconnues et normalisées. Les autres commandes ne sont
jamais identifiées par une simple sous-chaîne. Un fichier existant est conservé par `init` ;
`init --upgrade` actualise sa copie. Répéter ces commandes ne réécrit pas les fichiers conformes.

Le worktree est `CLAUDE_PROJECT_DIR`, ou le parent du dossier `scripts/` du garde déposé si
cette variable manque ; le `cwd` transmis par l’outil sert uniquement à résoudre les chemins
relatifs. `Write`, `Edit` et `MultiEdit` refusent toute cible extérieure, y compris un fichier
absent sous un lien symbolique, un lien pendant ou une traversée `..`. Bash contrôle les
mutations et exécutions reconnues : rm, mv, cp, mkdir, touch, tee, interpréteurs, npm, Git,
redirections, etc., avec les formes RTK et les changements de répertoire simples. Les lectures
externes restent possibles ; `/dev/null` et les duplications de descripteurs sont admis.
Comme dans CoproOS, le code inline et les mutations globales Git/npm sont refusés.

Le garde laisse passer `lsof -ti :9323 | xargs kill -9`, y compris avec
`2>/dev/null` : arrêter un processus ne constitue pas une écriture hors worktree.
Sous `xargs`, seules les options exactes `-0`, `--null`, `-r`, `--no-run-if-empty`,
`-t`, `--verbose`, `-n N`, `-L N`, `-P N`, `-s N`, `-E chaîne` et `-x` sont admises.
Les valeurs sont des arguments séparés ; N est un entier positif (zéro admis pour `-P`).
Une valeur `-E` portant une expansion non résolue (variable, glob, accolades…) est opaque.
`--` est accepté uniquement avant un programme explicite qui ne commence pas par `-`.
Toute option inconnue, abréviation ou forme collée, ainsi que `-J`, `-I`, `-i` et
`--replace`, reste opaque et refusée. Un nom de programme vide, dynamique ou contenant
`{` ou `}` est refusé. Les substitutions peuvent toucher le nom du programme :
`-J` sur macOS et `-I` sur GNU, d’où leur exclusion complète.

Le programme nommé et ses arguments visibles passent ensuite les contrôles ordinaires
du garde. Les mutations de fichiers, interpréteurs et lanceurs restent refusés sous
`xargs`, même avec des chemins visibles locaux : leurs arguments issus de stdin sont
inconnus. Cela inclut rm, mv, cp, tee, sh, bash, node, python, npm, RTK, env, sed/awk
et xargs imbriqué. Les redirections et les autres segments gardent leurs contrôles.
Le garde n’exécute ni xargs ni la commande analysée ; le test CoproOS original est
également rejoué contre sa copie déposée dans un dépôt temporaire interne aux tests.

**Limites : ce hook est un contrôle préalable, pas un sandbox système.** Son analyse shell
est conservatrice : substitutions, heredocs, structures complexes, chemins dynamiques et
wrappers opaques peuvent être refusés. Elle ne prouve pas les effets de tous les programmes
ou de leurs options : scripts du dépôt, programmes sed/awk, hooks Git, outils configurés,
écritures indirectes et état géré par les services restent de confiance et doivent être revus.
Les sources et destinations d’une commande mutante sont contrôlées ensemble : copier une
source extérieure peut donc être refusé. Le contrôle des liens précède l’exécution et ne
supprime pas les courses sur le système de fichiers ni les alias par liens physiques.
Il ne couvre pas les outils autres que Bash/Write/Edit/MultiEdit, un hook désactivé, ni un
garde modifié après `init` ; `check` contrôle les règles, pas l’intégrité de ce garde.
Un échec de démarrage (Node ou fichier absent) ou un dépassement du délai de cinq secondes
ne bloque pas l’outil côté Claude : surveiller les erreurs de hook au démarrage
([erreurs et délais des hooks](https://code.claude.com/docs/en/hooks#timeouts)).
Conserver le sandbox de l’agent et utiliser des wrappers de projet revus pour les services.

Codex ne reçoit aucun hook : `workspace-write` pose déjà sa frontière. **Une commande
autorisée côté Codex s’exécute hors sandbox** ; une règle allow ne garantit donc pas son
confinement au worktree. Cette livraison ne change ni le socle ni les règles générées des
deux moteurs et n’exécute aucune installation globale.

`check --codex` ajoute, si `codex` est installé, un contrôle natif de chaque commande d’exemple
avec `codex execpolicy check`. Il n’exécute pas ces commandes. Codex absent n’est pas un échec ;
un binaire présent qui échoue ou donne un verdict différent l’est. Ce contrôle reste hors ligne
et isole l’état éventuel du processus Codex dans `.agent-tmp/`, ensuite nettoyé.

## Consommer la politique depuis le code

Un harness Mastra ou une gate CI peut importer le générateur versionné du dépôt sans dépendance
externe ni outil global. `decisionForCommand(root, commande, moteur)` vérifie la copie du socle,
charge `agent-policy/policy.json`, puis combine leurs décisions pour `codex` ou `claude`.
Chaque couche garde ses `commandPrefixes` (RTK et RTK proxy par défaut) et son ciblage `engines`.
La priorité entre les couches et les gardes est `forbidden > prompt > allow`. La couche du
projet peut renforcer le socle ; elle ne peut pas assouplir sa décision.

Exemple de garde d’un harness, dans un module à la racine du dépôt :

```js
import { decisionForCommand } from './scripts/agent-policy/generate.mjs';

export function assertSandboxCommand(root, command) {
  const decision = decisionForCommand(root, command, 'codex');
  if (decision === 'prompt' || decision === 'forbidden') {
    throw new Error(`Commande refusée dans le sandbox du harness : ${decision}`);
  }
  // L'exécution reste soumise au sandbox et aux contrôles propres du harness.
  return decision;
}
```

L’API renvoie `'allow'`, `'prompt'`, `'forbidden'` ou `undefined` en l’absence de règle.
Par exemple : `git push` et `rtk git push` → `prompt`, `rm -rf x` → `forbidden`,
`npm run test:gate` → `allow` si ce script est autorisé par la couche du projet,
commande inconnue → `undefined`. `undefined` ne vaut pas autorisation de sortir du sandbox.
Le choix du moteur est explicite : les entrées `engines: ["claude"]` ne créent aucune règle Codex.

Les commandes acceptées sont des chaînes représentant un argv simple, selon la grammaire du
générateur : pas de pipeline, redirection, expansion ni enchaînement shell. Un moteur inconnu,
une commande hors grammaire, une source invalide, un lien symbolique ou un socle désynchronisé
lève une erreur ; le consommateur doit alors refuser l’exécution. L’API ne lance aucune commande,
ne génère aucun fichier et ne remplace ni l’analyse shell de l’agent ni le sandbox du harness.

## Mesurer la couverture avec replay

Depuis le dépôt dont on veut prendre en compte la couche projet :

```sh
agent-policy replay /chemin/vers/historique
```

La commande parcourt récursivement les fichiers `.jsonl` et combine le socle embarqué de
l’outil avec `agent-policy/policy.json` du répertoire courant, si présent. La sortie indique
si cette couche est absente. Elle n’utilise pas les permissions personnelles installées.
Les miroirs, `engines` et la priorité `forbidden > prompt > allow` sont conservés.

Le rapport donne, séparément pour Claude et Codex, les totaux et pourcentages `allow`, `prompt`,
`forbidden` et `aucune`, puis les dix familles les plus fréquentes par verdict. `aucune`
signifie absence de règle : demande attendue côté Claude selon son mode et ses autres
réglages, exécution encore soumise au sandbox côté Codex. Il s’agit d’une mesure statique
de cette politique, pas d’une reconstitution des décisions réelles de l’agent.

Les débuts affichés appartiennent à un vocabulaire fermé, par exemple `git diff […]` ou
`npm run […]` : aucun argument, nom de script libre, chemin, commande intégrale ou extrait
de JSON invalide n’est affiché, même en cas d’erreur. Les noms inconnus deviennent `autre`.
Le lecteur ne suit aucun lien symbolique et ignore les noms `.env*`. Il n’écrit aucun fichier
et n’exécute jamais les commandes de l’historique.

Le vocabulaire fixe comprend aussi `sleep`, `kill`, `open`, `curl`, `bash`, `sh`, `chmod`,
`mv`, `tee`, `xargs`, `time`, `brew`, `docker`, `supabase` et `psql`. Les sous-commandes Docker
déjà nommées restent distinctes. Un programme relatif commençant par `./scripts/` ou `scripts/`
est classé **script du dépôt** : aucun nom de script n’est affiché. Les formes citées et les
préfixes RTK sont reconnus. Seuls les premiers mots statiques servent à la famille ; les
arguments d’un interpréteur, les alias, les expansions et les chemins absolus ne sont pas
résolus pour deviner un autre programme. Nommer une famille n’ajoute aucune autorisation.

Formats pris en charge et limites :

- Claude : messages assistant `message.content[].type = "tool_use"`, outil `Bash`,
  champ `input.command`. Les appels répétés avec le même identifiant sont dédupliqués.
- Codex : lignes `response_item`, payload `function_call`, outils `exec_command`,
  `shell_command` ou `shell` (avec ou sans espace de noms), arguments JSON `cmd` ou
  `command`, y compris l’ancien argv `['bash', '-lc', commande]`.
- Codex JavaScript : payload `custom_tool_call` nommé `exec` ou `functions.exec`, avec
  le code dans `input`. Une analyse lexicale sans dépendance relève les appels directs
  `tools.exec_command(...)`, `tools.shell(...)` et `tools.shell_command(...)`. Leur unique
  argument doit être un objet contenant `cmd` ou `command` comme propriété explicite,
  citée ou non, dont la valeur complète est une chaîne simple, double ou un gabarit sans
  interpolation. Les échappements JavaScript et continuations de ligne sont décodés ;
  commentaires, espaces, sauts de ligne et virgules finales sont admis. Les appels sous
  `await`, `Promise.all` ou `Promise.allSettled` sont reconnus. Chaque littéral est rejoué
  comme un appel Codex ordinaire ; un conteneur peut donc ajouter plusieurs commandes.
  Son identifiant déduplique le groupe entier, sans supprimer deux commandes identiques
  présentes dans ce même groupe.
- Les **fragments JavaScript non analysés** ont huit causes fixes : variable, concaténation,
  gabarit avec interpolation, appel calculant la valeur, autre expression non littérale,
  objet ou arguments non pris en charge, syntaxe lexicale non prise en charge ou incomplète,
  aucun appel shell direct reconnu. Une cause est comptée par appel non extrait ; les deux
  dernières peuvent concerner le conteneur entier. Un conteneur mixte contribue à la fois
  aux commandes rejouées et à ces causes. Les conteneurs **sans commande littérale** sont
  aussi ventilés séparément, une fois chacun selon leur première cause. Une chaîne vide
  est un littéral extrait, puis compté comme appel invalide, comme hors conteneur.
- L’analyse JavaScript ne résout ni variables, alias, clés calculées, spreads, accesseurs,
  propriétés abrégées, clés dupliquées, tableaux argv ni gabarits étiquetés. Une valeur
  entre parenthèses reste une expression non littérale. Les commentaires et textes des
  chaînes/gabarits ne créent aucun appel ; les appels directs dans les expressions d’une
  interpolation sont relevés sans calculer cette interpolation. Un slash hors chaîne ou
  commentaire (division ou expression régulière), une erreur lexicale, un groupe inachevé
  ou une imbrication supérieure à 128 invalide l’extraction du conteneur entier : aucune
  extraction partielle n’est utilisée. Ce sous-ensemble évite de nécessiter un parseur
  JavaScript complet. Aucun contenu n’est évalué, importé ou lancé dans un sous-processus.
  Il s’agit d’un relevé de sites d’appel : boucles, branches, mutations et fréquence réelle
  d’exécution ne sont pas interprétées. Les tests ne lisent que des historiques synthétiques.
- `&&`, `||`, `;`, sauts de ligne et pipelines simples sont décomposés en tenant compte
  des guillemets. Le résultat le plus strict des segments gagne ; une absence de règle
  empêche le composé d’être compté comme allow. Les redirections bénignes `2>&1`,
  `2>/dev/null`, `>/dev/null` et `&>/dev/null` sont retirées avant l’évaluation de chaque
  segment, comme pour les permissions Bash de Claude Code. Espaces ou tabulations avant
  `/dev/null` sont admis ; les guillemets et échappements restent des arguments littéraux.
  Le retrait conserve les frontières des mots et ne masque jamais le segment suivant.
- Les **syntaxes non analysées** sont ventilées en quatre causes fixes : redirection vers
  fichier (ou autre redirection non prise en charge), substitution, structure shell, heredoc.
  Une commande compte une fois, dans la cause du premier obstacle rencontré par l’analyseur.
  Les autres redirections, dont `<`, `>>`, les autres descripteurs et destinations, restent
  non analysées ; `<<-` et les here-strings `<<<` rejoignent la catégorie heredoc. Un
  prompt/deny textuel connu peut être conservé, jamais un allow par simple préfixe.
  Ces totaux incluent donc aussi des commandes prompt/forbidden ; ils ne sont pas synonymes
  du verdict `aucune`. Les limites JavaScript gardent leurs compteurs séparés.
- Les lignes JSON invalides, appels invalides et doublons sont comptés sans afficher leur
  contenu. Les sorties d’outils et le texte conversationnel ne sont pas des commandes.

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
    "sha256": "cbc8f39bf27f6371920f4e8cd912c3411b31756f507a4bd18f1cec897a784d44",
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
`claudeDeny` et `claudeAsk` ne sont générées et testées que si Claude est ciblé. La validation structurelle du
JSON reste commune. Un même motif peut avoir deux entrées si leurs moteurs sont disjoints ; un
doublon sur le même moteur est refusé. Le contrôle natif `check --codex` ne reçoit que les exemples
Codex, y compris ceux des miroirs.

Principe du socle : **une lecture que le sandbox Codex exécute déjà ne reçoit pas de règle Codex**.
Une règle Codex `allow` autorise la sortie du sandbox ; elle n’est pas nécessaire pour ces lectures.
Ce principe exclut aussi les règles `prompt` et `forbidden` pour les lectures et utilitaires
confinés au workspace. Une exception explicite autorise désormais les filtres `rg`, `grep`,
`head`, `tail`, `wc`, `sort`, `cut`, `jq` côté Codex, miroirs RTK compris. Leur `residualRisk`
documente la sortie du sandbox, notamment `rg --pre`, le miroir natif `rtk grep --pre` et les
options libres de `sort`. `sed` sans `-n`, `awk` et `uniq` restent sans règle Codex : pour `uniq`, une
règle de préfixe ne saurait garantir l’absence d’un argument désignant un fichier de sortie.
Une seconde exception explicite autorise les neuf lectures Git détaillées plus bas, afin
qu’un composé comme `rg --files src && git diff --check && lsof -ti :3001` soit allow
segment par segment, même si `lsof` demande une sortie du sandbox. `git fetch`, qui accède
au dépôt distant, est également autorisé pour les deux moteurs selon l’arbitrage décrit plus
bas. Une troisième exception ajoute `sed -n`, `cat` et `ls` côté Codex pour les composés
comme `lsof -ti :3001 && sed -n '1,20p' f && cat g && ls d`. Les autres lectures Git,
utilitaires et écritures relatives continuent de cibler Claude seul.
`git add`, `git commit`, `lsof`, les lanceurs de tests et les scripts npm nommés conservent
leurs autorisations pour les deux moteurs.
Les lectures réseau `gh pr checks` et `gh run view` restent également en allow pour les deux
moteurs, avec leurs miroirs RTK : Codex doit pouvoir accéder au réseau sans redemander un accord.

`commandPrefixes` est une option à la **racine de la politique**, indépendante de `engines` :

```json
{
  "version": 1,
  "commandPrefixes": [["rtk"], ["rtk", "proxy"]],
  "entries": [
    {
      "pattern": ["git", "status"],
      "engines": ["claude"],
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
sans doublon. L’absence de `commandPrefixes` active par défaut `[["rtk"], ["rtk", "proxy"]]`,
y compris dans une politique de dépôt et dans le générateur autonome. Une liste vide désactive
explicitement les miroirs ; une liste non vide remplace les préfixes par défaut. Cette option décrit un
wrapper de confiance qui transmet les arguments ; elle ne lui accorde aucune permission seule.
Les mêmes contrôles d’allow s’appliquent aux entrées dérivées.

| Commande | Codex | Claude |
| --- | --- | --- |
| `rtk git status` | allow | allow |
| `rtk git push origin main` | prompt | ask |
| `rtk proxy rm file` | forbidden | deny |
| `rtk rg needle src` | allow | allow |
| `rtk proxy cat README.md` | allow | allow |
| `rtk proxy cat .env` | allow | deny |

Le socle déclare les deux préfixes ci-dessus. Une couche de dépôt en bénéficie sans les redéclarer :
`npm run test:gate` génère aussi `rtk npm run test:gate` et `rtk proxy npm run test:gate` avec la
même décision et les mêmes moteurs. Aucun `rtk npm run` générique n’est autorisé.
Les règles propres `rtk grep`, `rtk read`, `rtk ls`, `rtk diff`,
`rtk gain`, `rtk discover` et `rtk session` sont autorisées pour Claude seul. Leurs formes
préfixées sont également générées, sans expansion récursive. Les collisions de même motif et
décision sont dédupliquées dans les sorties (exemples Codex réunis) ; des décisions différentes
restent soumises à la priorité habituelle. Aucun `rtk` ou `rtk proxy` libre n’est autorisé.
Les miroirs des entrées `grep` et `ls` Codex ajoutent des allow `rtk grep` et `rtk ls` séparés ; le programme
`rtk read`, même s’il peut remplacer `tail` via le hook, reste sans règle Codex.

La génération teste la politique, sans exécuter RTK ni les commandes d’exemple. Elle ne garantit
pas qu’une version de RTK accepte toutes les formes : par exemple, `rtk proxy <commande>` sert à
transmettre une commande non prise en charge nativement. RTK 0.45.0 a été inspecté avec son aide
locale et `rtk rewrite` : `grep` transmet des options de recherche à ripgrep, `read` accepte plusieurs fichiers,
et `diff` compare des fichiers. Les statistiques RTK peuvent écrire leur état local réversible.
La configuration et les filtres RTK doivent être de confiance.

Le hook peut changer la sous-commande, au-delà du simple préfixe. Formes natives vérifiées avec
RTK **0.45.0** et couvertes par les tests hors ligne :

| Commande source | Réécriture native | Autorisation |
| --- | --- | --- |
| `npx tsc --noEmit` | `rtk tsc --noEmit` | allow, deux moteurs |
| `npx vitest run [fichiers]` | `rtk vitest [fichiers]` | allow, deux moteurs ; `rtk vitest run` également couvert |
| `npx playwright test` | `rtk playwright test` | allow, deux moteurs |
| `npm run test:gate` | `rtk npm run test:gate` | décision du script nommé dans la couche de dépôt |
| `cat README.md` | `rtk read README.md` | allow Claude |
| `tail -n 20 README.md` | `rtk read README.md --tail-lines 20` | allow Claude |

Les autres sous-commandes natives identifiées par l’aide RTK et couvertes dans le socle sont `git`, `gh`,
`docker`, `rg`, `npx`, `find`, `ls`, `grep`, `wc`, `curl`, `wget`, `psql` et `php`.
Le miroir conserve la décision de chaque
préfixe source couvert, y compris `prompt` et `forbidden` ; leur présence dans cette liste
n’accorde pas une autorisation générale. `diff`, `gain`, `discover` et `session` sont couverts
directement. `rtk --version` est une lecture Claude. Les formes de tests font confiance aux
dépendances et à la configuration du projet, comme leurs commandes d’origine.

## Lectures Claude et gardes

Règle générale : **pas de joker interne dans un allow Claude**. Les préfixes argv littéraux
produisent `Bash(commande:*)`. Le champ optionnel `claudePattern`, exclusif de `pattern` et
réservé à `engines: ["claude"]`, permet en allow uniquement les formes exactes de `uniq`.
Il conserve les assertions `match` / `notMatch` et suit les miroirs ; aucune règle Codex n’est
inventée pour représenter un motif Claude.

**Aucune exception au refus des jokers internes**, même accompagnés de gardes ask ou deny.
Le suffixe de préfixe `:*` reste admis en fin de motif. Les formes exactes `uniq` n’ont
aucun joker. Le générateur contrôle cette règle dans la source et dans les permissions
émises, y compris les miroirs et la copie autonome déposée par `init`.

L’ancienne exception `git -C * <commande>` est retirée après le signalement au démarrage
de Claude Code v2.1.278 : le joker placé avant la sous-commande absorbe aussi des options.
Les 22 entrées `claudePattern`, le catalogue de sous-commandes et toutes les gardes propres
à `git -C` sont supprimés. Aucun chemin littéral ne remplace les chemins de worktrees dynamiques.
Le catalogue des **options longues Git**, utilisé pour les abréviations sans `-C`, est conservé.

**`git -C <chemin> <commande>` reste sans règle du socle**, avec ses miroirs `rtk` et
`rtk proxy` : Claude demande donc un accord par défaut. Aucune règle prompt générale
`git -C` n’est ajoutée, afin de ne pas masquer une permission plus précise d’une couche
de dépôt. Les formes sans `-C`, leurs gardes et toutes les règles Codex sont inchangées.
La parité précédemment prévue pour `git -C` est remplacée par l’item 14 du plan ; les
items 9 et 10 le signalent explicitement. Une ancienne exception dans une couche de projet
est désormais refusée à la validation, avant toute écriture.

Mesure du retrait par rapport à `main` au commit `f5a5f59`, miroirs compris :

| Permissions Claude | Avant | Après |
| --- | ---: | ---: |
| allow | 393 | 327 |
| ask | 1 839 | 912 |
| deny | 944 | 944 |
| **Total** | **3 176** | **2 183** |

Les tests conservent les empreintes des règles Codex et de toutes les permissions Claude
hors `git -C`, ordre compris. Aucun install réel n’est nécessaire pour ces mesures.

`git add` et `git commit` restent allow pour les deux moteurs. Leur `residualRisk` précise
que `--edit` lance l’éditeur configuré et que `git commit --gpg-sign` lance le programme de
signature configuré. Le user accorde sa confiance à ces outils préconfigurés comme aux hooks
déjà exécutés par commit. Ces variantes ne reçoivent pas de garde demandant un accord.

`git fetch` est allow pour les deux moteurs : il lit le dépôt distant et modifie les objets
et références locaux, sans publication distante (`local-reversible`). Claude demande un
accord pour `--upload-pack` et `-c`, à toute position couverte par les gardes textuelles
sans `-C`. Avec `-C`, l’absence de règle demande déjà un accord.
**Codex conserve le risque `--upload-pack`**, y compris `--upload-pack=<programme>` :
un préfixe ne filtre pas cette option libre capable d’exécuter un programme. L’acceptation
explicite est documentée dans `residualRisk`, comme pour `rg --pre` et `git diff --ext-diff`.

Les mutations `push`, `pull`, `merge`, `rebase`, `reset`, `checkout`, `stash` et les écritures
de worktree restent soumises à accord côté Claude (règle explicite ou absence d’allow), avec
ou sans `-C` ; les variantes déjà interdites, telles que `git reset --hard`, gardent leur refus.
Les lectures comme `stash list` restent autorisées. **Écart assumé : `git worktree add` sans
`-C` conserve son allow Codex historique ; Claude reçoit un prompt explicite.** Aucun allow
Codex de main n’est retiré.

Les lectures Git directes sont autorisées pour Claude : `status`, `diff`, `log`,
`show`, `rev-parse`, `grep`, `ls-files`, `ls-tree`, `blame`, `remote -v`, `stash list`,
`tag --list`, `worktree list`. `merge-tree` est classé `local-reversible` : son mode moderne
crée des objets Git sans modifier les branches, l’index ou le worktree.
`git branch` permet aussi la création locale ; `-d`, `-D`, `-m`, `-M`, `-c`, `-C`, `-u`, `-f`,
`--set-upstream-to`, `--unset-upstream` et leurs alias de mutation demandent un accord.
`git remote -v` garde ses protections contre les sous-commandes de mutation.

Codex reçoit aussi des entrées explicites pour `git status`, `diff`, `log`, `show`, `rev-parse`,
`ls-files`, `grep`, `worktree list` et `merge-tree`, avec leurs miroirs `rtk` et `rtk proxy`.
Ces allow autorisent une exécution hors sandbox. Leurs `residualRisk` documentent les options
libres non filtrables par préfixe : `--ext-diff` peut exécuter un programme externe et
`--output` écrire un fichier, pour les sous-commandes qui les acceptent. Le risque est accepté
explicitement, comme `rg --pre`. Pour `git grep`, `-O<programme>` /
`--open-files-in-pager=<programme>` peut lancer un programme choisi par l’appelant, sans
configuration préalable : ce risque supplémentaire est également accepté. La confiance dans
la configuration Git, ses filtres et son pager existants reste une hypothèse. Les gardes
Claude restent applicables à Claude ; elles ne filtrent pas les arguments Codex.

**Aucune règle Codex pour `git branch --list`.** `--no-list` peut annuler le mode lecture :
`git branch --list --no-list -D <branche>` permettrait une suppression sous le même préfixe.
Le gain ne justifie pas ce risque, selon l’arbitrage du user. Cette exclusion concerne aussi
les miroirs RTK ; la commande reste régie par le sandbox Codex.

Les gardes d’options respectent désormais leur début d’argument. Par exemple, les quatre
motifs `sed -i*`, `sed * -i*`, `sed --in-place*`, `sed * --in-place*` remplacent `sed *-i*`.
Un chemin contenant `-integration`, `-immutability`, `--pre`, `--output`, `--ext-diff`,
`--upload-pack` ou `-c` ne suffit plus à déclencher ces gardes. Les miroirs sont dérivés de
la même source. Pour les lectures protégées par un deny, les vrais `--pre` et `--output`
(argument séparé ou `=valeur`) sont refusés ; les motifs plus larges pouvant attraper
`--pre-glob` demandent un accord. `--output-indicator-new`, `--output-indicator-old` et
`--output-indicator-context` restent allow grâce aux gardes bornées de `--output`.
Les lectures Git directes comme `diff` et `log` gardent leurs deny sur
`--ext-diff` et `--upload-pack` ; le pager de `git grep` garde aussi son deny direct.
Les motifs `-c*` Git, parfois des options de lecture légitimes, sont en ask.
Les gardes d’options de `add`, `commit` et `fetch` directs restent toutes en ask :
`--output`, `--ext-diff`, `--upload-pack`, `-c`,
`--exec-path`, `--config-env`. Elles peuvent rencontrer un argument légitime, par exemple
un message de commit parlant de `--output=…`. Il ne reste aucune garde propre à `git -C`.

Git accepte des [abréviations uniques d’options longues](https://git-scm.com/docs/gitcli).
La table `GIT_OPTION_PREFIXES` de `lib/generate.mjs` fige les préfixes ci-dessous. Les listes
complètes d’options dont elle dérive sont versionnées dans
[`test/fixtures/git-long-options.json`](test/fixtures/git-long-options.json), capturées avec
`git <commande> --git-completion-helper-all` sur Git 2.50.1 (Apple Git-155), le 20 septembre
2026. Les tests recalculent le plus court préfixe unique depuis ces listes, hors ligne ; le
générateur ne lance pas Git pour les obtenir. La liste du parseur de diff s’applique aussi à
log, show, stash list et blame, qui lui transmettent leurs options de diff.

| Commande / portée | Option gardée | Préfixe ajouté en ask | Options voisines ou justification |
|---|---|---|---|
| fetch | `--upload-pack` | `--upl*` | `--update-head-ok`, `--update-shallow`, `--unshallow` restent allow. |
| grep | `--open-files-in-pager` | `--op*` | `--only-matching` et `--or` sont distincts. |
| diff, log, show, stash list, blame | `--ext-diff` | `--ext*` | `--exit-code` reste allow. |
| branch | `--delete` | `--d*` | Seule option commençant par d. |
| branch | `--move` | `--mo*` | Épargne `--merged`. |
| branch | `--copy` | `--cop*` | Épargne `--color`, `--column`, `--contains`. |
| branch | `--force` | `--forc*` | Épargne `--format`. |
| branch | `--create-reflog` | `--cr*` | Distinct des autres options commençant par c. |
| branch | `--edit-description` | `--e*` | Seule option commençant par e. |
| branch | `--set-upstream-to` | `--set-upstream-*` | `--set-upstream` est une autre option exacte, obsolète. |
| branch | `--unset-upstream` | `--u*` | Seule option commençant par u. |
| Gardes Git de sortie | `--output` | Aucun ; motifs bornés | Tout préfixe plus court que `--output` est ambigu avec les trois `--output-indicator-*`, donc refusé par git ; aucune abréviation n’existe. |
| Options globales | `--exec-path`, `--config-env` | Aucun ; noms complets conservés | Le parseur global de [git.c](https://github.com/git/git/blob/v2.50.1/git.c) compare les noms complets sans accepter leur abréviation. |

Les préfixes élargis sont **toujours ask, jamais deny**. Les formes complètes conservent leur
décision : par exemple `git grep --open-files-in-pager=vim` reste refusé, et `git fetch
--upload-pack=programme` reste soumis à accord. `--output*` est supprimé partout ; seuls
`--output`, `--output=*`, `--output *` subsistent, en début d’argument comme après d’autres
arguments, avec la décision complète antérieure. Les gardes suivent les deux miroirs RTK.
Le générateur exige ces gardes en ask lorsqu’il valide une garde complète concernée pour
une commande Git sans `-C` ; les abréviations avec `-C` restent sans règle comme la commande entière.

`--edit` de add/commit et `--gpg-sign` de commit ne sont pas gardés : leurs programmes
préconfigurés restent de confiance selon l’arbitrage existant. Le correctif d’abréviations
ne change aucune règle Codex. Les listes d’options sont un instantané à actualiser avec Git ;
un préfixe textuel peut aussi rencontrer un argument légitime, qui demande alors un accord.

**Une garde susceptible d’attraper un usage légitime est en `prompt` (`claudeAsk`), jamais en
refus.** Cela vaut notamment pour l’écriture en place de sed, les gardes larges de chemins
(`..`, expansions), `lsof -D` et `npm audit … fix`. Une règle plus précise réellement interdite
reste prioritaire. Une garde protège un texte ; elle n’est pas un analyseur des arguments.

Outre les lectures existantes (`ls`, `cat`, `head`, `tail`, `grep`, `wc`, `sort`, `rg`, `sed -n`,
`echo`, `printf`, `pgrep`, `xxd`, `dig`, `pbpaste`, `which`), Claude reçoit `jq`, `awk`, `cut`,
`tr`, `column`, `diff`, `comm`, `basename`, `dirname`, `realpath`, `stat`, `file`, `du`, `df`,
`gh run watch`, `gh run view` et `gh pr checks`. `file -C` / `--compile` est refusé.

Arbitrages des filtres :

- `awk` est Claude seul. Redirections, pipes, `system()`, `getline`, `-f`, `-i`, `@include`,
  `@load` et les options de chargement apparentées demandent un accord. La comparaison
  `$3 > 5` peut correspondre à la garde : elle n’est jamais refusée. Aucun allow Codex.
- `uniq` utilise des permissions **exactes**, sans `:*` : `uniq`, `uniq -c`, `uniq -d`,
  `uniq -u`, `uniq -i`, `uniq -c -i`, `uniq -i -c`, `uniq -d -i`, `uniq -i -d`,
  `uniq -u -i`, `uniq -i -u`, `uniq -cd`, `uniq -ci`, `uniq -di`, `uniq -ui`.
  Tout ajout d’argument sort de cette liste et reste soumis à accord faute de règle Claude.
  Un prompt général masquerait même ces formes exactes ; il n’est donc pas généré.
  Aucun préfixe Codex pour `uniq`, même sous RTK : il élargirait ces formes à une écriture.
- `env` reste en prompt, même sans argument, car il peut révéler des jetons.
- `sqlite3` reste en prompt : limiter la base à `.agent-tmp` ne confine ni SQL ni les
  méta-commandes comme `.shell` ou `.output`.
- `cd` est Claude seul, `local-reversible`. Dans `cd chemin && commande`, chaque segment
  conserve sa propre décision ; `cd` n’autorise jamais une commande suivante inconnue.

Les gardes `.env*` ciblent le début du basename : `.env`, `config/.env.local` et les formes
citées sont protégés ; `report.env.integration.md` ne déclenche pas la garde. `cat`, `head`,
`tail`, `rtk read` et `rtk diff` conservent leurs deny. Pour `grep`, `rg`, `sed` et `rtk grep`,
le texte peut être un motif de recherche légitime : les gardes `.env*` sont en ask.
Les allow concernés exigent ces gardes à la validation, avec celles des options sensibles.

### Lectures sed -n, cat et ls côté Codex

Trois entrées `engines: ["codex"]`, `decision: "allow"`, `riskClass: "read-only"`
autorisent `sed -n`, `cat` et `ls`, ainsi que leurs formes `rtk` et `rtk proxy` : neuf
règles Codex supplémentaires. Chaque segment peut ainsi participer à un composé qui
comprend aussi une commande hors sandbox. Aucune permission Claude n’est modifiée.

Pour sed, seul le préfixe exact `["sed", "-n"]` est admis par `validateAllow`. Ni `sed`
seul, ni `sed -e`, `sed --quiet` ou `sed -nE` ne reçoivent d’allow Codex. Le `residualRisk`
doit citer `-i` et `--in-place` : un préfixe ne peut pas filtrer ces options à une autre
position, risque accepté par le user comme `sort -o`. Les programmes sed eux-mêmes restent
libres, notamment [`w` (écriture) et `e` sur GNU sed (exécution)](https://www.gnu.org/software/sed/manual/html_node/sed-commands-list.html) ; `-n` ne constitue pas une
frontière d’écriture. Claude conserve ses gardes en ask pour `-i` / `--in-place` et ses
gardes `.env*` existantes.

Les préfixes `cat` et `ls` ne filtrent pas les noms `.env`, déjà lisibles dans le sandbox ;
cette limite figure dans leurs `residualRisk`. `ls` affiche les noms et métadonnées, pas le
contenu des fichiers. Les options GNU vérifiées dans les sources de
[`cat`](https://github.com/coreutils/coreutils/blob/master/src/cat.c) et de
[`ls`](https://github.com/coreutils/coreutils/blob/master/src/ls.c), ainsi que les options
des manuels macOS locaux, n’offrent ni destination de fichier à écrire ni programme à lancer.
Les redirections shell restent distinctes des options de ces programmes.

`awk`, `uniq`, les lectures `find` et `git branch --list` restent sans règle Codex ; les
refus destructifs `find -delete` / `find -exec` sont conservés. Le hook peut réécrire `cat`
en `rtk read`, qui reste sans règle Codex : cette livraison ajoute les miroirs `rtk cat`
et `rtk proxy cat`, sans nouvelle autorisation native `rtk read`.

Après fusion, relancer `agent-policy install` pour actualiser les règles Codex installées,
puis `agent-policy init --upgrade` dans chaque dépôt pour rafraîchir sa copie du socle.
Cette livraison n’exécute aucune installation réelle.

`pwd`, `date`, les lectures `--version`, `mkdir -p`, `cp` et `touch` restent Claude seuls.
Les écritures relatives gardent leurs refus des chemins absolus et `.env*` ; les motifs
ambigus de traversal et d’expansion demandent un accord. Ces gardes ne résolvent ni liens
symboliques, montages, chemins échappés, fichiers indirects ni parcours récursifs implicites.
Elles ne constituent pas un contrôle des fichiers réellement ouverts. `read-only` décrit
l’usage demandé : les programmes sed et les options libres de certains filtres restent
des limites documentées dans `residualRisk`.

`lsof -i`, `lsof -ti` et `lsof -nP` restent autorisés pour les deux moteurs. `lsof -D` est en
prompt Codex ; sa garde textuelle Claude est désormais en ask. Les formes collées comme
`lsof -i:3000` ne correspondent pas aux tokens Codex séparés.

Limites Codex du miroir, identiques sous `rtk` et `rtk proxy` :

| Formes | Limite |
| --- | --- |
| `git -C …` | Aucune règle du socle, pour les deux moteurs ; Claude demande un accord par défaut. |
| Formes exactes `uniq` | Fin d’arguments non exprimable : aucune règle Codex ; allow Claude exacts conservés. |
| `git branch --list` | Aucune règle Codex : `--no-list -D` annulerait la lecture et permettrait une suppression. |
| Lectures Git avec `--ext-diff`, `--output` ; `git grep -O` / `--open-files-in-pager` | Risques d’exécution et d’écriture acceptés explicitement dans les allow Codex ; aucune exclusion d’options libres. |
| `.env*`, options sensibles d’`awk`, `file` | Gardes textuelles propres à Claude ; aucune règle Codex pour awk et file. Les filtres Codex autorisés, cat et ls ne filtrent pas les chemins `.env*`. |
| `sed -n … -i` / `--in-place` | Seul le préfixe exact `sed -n` est allow Codex, avec risque accepté comme `sort -o`. Les options en position libre et les programmes sed ne sont pas filtrés ; gardes Claude inchangées. |
| `rg … --pre`, `rtk grep … --pre` | L’allow Codex explicite conserve cette capacité ; risque résiduel documenté. |
| `sort -o`, `sort --compress-program` | Le préfixe Codex autorise aussi ces variantes, comme les arguments libres des autres filtres convenus. |
| `git fetch … --upload-pack` | Allow Codex avec risque d’exécution accepté ; garde ask Claude. |
| `git worktree add` | Allow Codex sans `-C` conservé ; prompt Claude avec ou sans `-C`. |
| `npm audit … fix` | Position libre non filtrable ; sous-préfixe `npm audit fix` en prompt. |
| `lsof … -D…` | Le préfixe de lecture Codex ne sait pas exclure une option suffixe. |
| `find … -delete/-exec`, `perl -pi*` / `-i*` | Position libre ou suffixe dans un token. |
| Heredocs, exécutables absolus, `head-*`, `tail-*` | Syntaxe shell ou joker dans le nom exécutable ; gardes Claude seules. |

La priorité est `forbidden > prompt > allow`. Une permission Claude canonique est
`Bash(gh pr merge:*)`. Un `prompt` général ne permet donc aucune exception `allow` plus précise :
les sous-commandes Docker Compose et Supabase sont énumérées. Une commande nouvelle ou écrite
avec d’autres options initiales reste **sans autorisation du socle**, soumise au comportement des
agents et du sandbox ; cela ne signifie pas automatiquement `forbidden`.

Les risques sont `destructive-program`, `remote-publication`, `cloud-mutation`, `paid-provider`,
`shared-local-state`, `arbitrary-execution`, `read-only`, `local-reversible`.

Le schéma et `validatePolicy` imposent le même contrat à toutes les entrées, quels que soient
leurs moteurs : `allow` exige `read-only` ou `local-reversible` ; `prompt` et `forbidden`
exigent une des six classes de refus (`destructive-program`, `remote-publication`,
`cloud-mutation`, `paid-provider`, `shared-local-state`, `arbitrary-execution`). Une
incompatibilité échoue à la validation avant toute écriture, pour le socle comme pour une
couche de dépôt. Les consommateurs tels que le harness Mastra peuvent ainsi traiter les
refus avec ce vocabulaire fermé.

`env` est classé `arbitrary-execution` : `env <commande>` peut lancer un programme arbitraire,
et la forme sans argument peut afficher des secrets de l’environnement. Sa décision reste
`prompt`, pour Claude et ses miroirs RTK ; aucune autre entrée du socle n’est reclassée.

## Arbitrage des variantes dangereuses

Question par préfixe : **la variante peut-elle nuire seule, sans étape préalable déjà soumise à accord ?**

- Sous-préfixe identifiable : conserver l’autorisation et ajouter une règle plus stricte,
  par exemple `npm audit` en `allow`, `npm audit fix` en `prompt`.
- Configuration préalable nécessaire, ou effet local réversible accepté : expliquer la limite
  dans le champ optionnel `residualRisk`. `npx tsc --noEmit false` reste ainsi autorisé.
- Option libre suffisante pour exécuter une commande ou écrire hors dépôt : aucun `allow`
  générique Codex par défaut. Les filtres explicitement convenus ci-dessus constituent une
  exception documentée, comme les lectures Git convenues et `git fetch --upload-pack` ;
  `sed` sans `-n` et `awk` restent confinés.

Les gardes supplémentaires Claude se déclarent dans la **même source**, avec leurs propres tests :

```json
"claudeAsk": [
  {
    "pattern": "git fetch * --upload-pack*",
    "match": ["git fetch origin --upload-pack=custom-command"],
    "notMatch": ["git fetch --prune origin"]
  }
]
```

Ce champ optionnel ajoute seulement des `ask` lorsque Claude est ciblé, comme la garde
`git branch * -D*`. Le champ `claudeDeny` a exactement la même forme (`pattern`, `match`,
`notMatch`) et ajoute des `deny`. Les deux champs sont validés, testés et reproduits par les miroirs. Ils ne
peuvent jamais assouplir la décision de l’entrée : `deny > ask > allow`.
Les jokers sont des correspondances textuelles, potentiellement plus restrictives, sans analyse
exhaustive des options combinées. Le générateur ne prétend pas inspecter le contenu d’un wrapper.
Un script nommé doit lui-même refuser les arguments libres, le chargement de secrets non prévu et
les contournements ; sa revue fait partie de la PR qui ajoute son autorisation.

Choix explicites du socle après application de ce critère :

| Famille | Choix et limite |
| --- | --- |
| Lectures Git | Neuf préfixes explicites Codex avec risques acceptés ; lectures Claude avec gardes. `git -C` n’a plus de règle du socle. |
| Git local | Hooks, filtres, pager, éditeur et signature configurés supposés de confiance ; aucun `git -c …` n’est autorisé globalement. `worktree add` est allow Codex, prompt Claude. |
| `git fetch` | Allow pour les deux moteurs sans `-C`, et Claude avec `-C`. `--upload-pack` / `-c` en ask Claude ; risque `--upload-pack` Codex accepté. |
| `lsof` | Lectures `-i`, `-ti`, `-nP` autorisées explicitement. `-D` reste soumis à accord en préfixe Codex et soumis à accord par garde Claude ; les options suffixes et valeurs collées restent une limite Codex. |
| `npm audit` | `fix` canonique en `prompt`. Codex ne couvre pas `npm audit --json fix` avec ce sous-préfixe ; la limite est dans `residualRisk` et Claude dispose d’un refus supplémentaire. |
| `npm ci` | `allow` sur les deux moteurs, risque `local-reversible` : installation exacte du lockfile, déjà confiée aux wrappers de projet. Dépendances et scripts d’installation supposés de confiance ; accès réseau/cache possibles. |
| `npm audit fix`, `git restore`, `git worktree remove` | `prompt` conservé sur les deux moteurs, par arbitrage explicite : dépendances modifiées, travail non commité perdu ou worktree d’un autre chantier supprimé. |
| `npx tsc --noEmit` | Compilateur installé et configuration locale de confiance nécessaires ; le préfixe ne vérifie pas leur présence. `npx` peut télécharger un paquet absent. Réactivation de l’émission acceptée comme effet local réversible. |
| `docker compose` | Lectures `ls`, `ps`, `images`, `top` distinguées des mutations. La lecture de configuration/environnement par Compose suppose un projet de confiance, explicitée dans `residualRisk`. |
| `npx supabase status` | `prompt` également, car `-o env` peut exposer les clés locales. |
| `curl` / `wget` | Interdiction conservatrice des commandes entières : un simple préfixe ne sait pas exprimer « seulement lorsqu’il est pipé vers un shell ». Cela bloque la source de ces pipelines ; utiliser un téléchargement contrôlé. |

Le socle n’autorise aucun chemin ni point d’entrée de projet. Les chemins de refus couvrent
l’exécutable standard `./node_modules/.bin/tsx`, les quatre familles d’exécutables absolus
ci-dessous et les gardes des écritures relatives Claude. Les deux refus `with-env.sh npx tsx -e` et `with-supabase-env.sh npx tsx -e` restent
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
[`supabase status`](https://supabase.com/docs/reference/cli/supabase-status),
[redirections et pipes awk](https://www.gnu.org/software/gawk/manual/html_node/I_002fO-Functions.html),
[fichier de sortie uniq](https://www.gnu.org/s/coreutils/manual/html_node/uniq-invocation.html),
[méta-commandes sqlite3](https://www.sqlite.org/cli.html),
[`git merge-tree`](https://git-scm.com/docs/git-merge-tree),
[`git grep` et son pager](https://git-scm.com/docs/git-grep),
[négation des options Git](https://git-scm.com/docs/gitcli),
[implémentation de `git branch`](https://github.com/git/git/blob/master/builtin/branch.c).

Pour les arbitrages de parité : [`git add --edit`](https://git-scm.com/docs/git-add),
[`git commit --edit` et `--gpg-sign`](https://git-scm.com/docs/git-commit),
[`git fetch --upload-pack`](https://git-scm.com/docs/git-fetch).

## Vérification du dépôt de l’outil

```sh
npm test
```

Le test `test/codex-allow-retention.test.mjs` compare les allow Codex **générés**, miroirs compris,
aux 147 allow de `main` au commit `346abb309b0e943159d9fb73a8535105da1871b0`, conservés dans
`test/fixtures/codex-allow-main.json`. Il ajoute les règles de `origin/main` (ou `main`) lorsque
la référence locale existe, sans accès réseau. La copie versionnée maintient le contrôle dans
les archives et checkouts CI superficiels. Tout retrait doit être nommé par son argv exact dans
`documentedRemovals` du test, avec une justification reproduite dans ce README ; cette liste
est actuellement vide. La référence ne se rafraîchit que depuis un `main` relu et fusionné.

Les tests `node:test` couvrent le schéma, toutes les entrées et gardes du socle, la priorité des
règles, les pièges de préfixe, les sorties, la préservation des hooks et des permissions non-Bash,
les dérives Bash et les ajouts non-Bash manuels, deux dépôts
autonomes, `init --upgrade`, le contrôle natif optionnel, la confirmation d’installation,
les sauvegardes, le retour arrière, les échecs d’écriture, les 31 refus globaux et les 2 wrappers
simulés (formes directes et RTK), la post-condition Claude, le contrat/rendu exact des briefs,
le ciblage `engines`, les miroirs hérités par les dépôts, les formes natives RTK, les sessions courantes,
la copie versionnée du socle, ses dérives et l’API autonome de décision combinée,
les gardes de lecture/écriture, les injections dans les jokers et le rejeu JSONL sans écriture,
exécution ni affichage d’arguments. Aucun appel fournisseur, aucun
paquet téléchargé et aucune installation globale ne sont nécessaires.
