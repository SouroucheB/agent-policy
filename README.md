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
.codex/rules/project.rules           # sortie générée
.claude/settings.json                # entrées Bash générées ; autres permissions et clés conservées
```

`init` conserve les fichiers existants et ajoute les copies absentes. `agent-policy init --upgrade`
rafraîchit le socle, sa version, le générateur et la commande `brief` depuis l’outil installé,
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
  `command`, y compris l’ancien argv `['bash', '-lc', commande]`. Les appels
  `custom_tool_call` nommés `exec` du runtime JavaScript sont comptés séparément comme
  **conteneurs non analysés** : leur code n’est ni évalué ni supposé représenter un Bash.
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
  du verdict `aucune`. Les conteneurs JavaScript Codex gardent leur compteur séparé.
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
    "sha256": "994afe748bdddf97bc9975775dcd17afeef64c3ec4a5af46163655177b634dc8",
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
options libres de `sort`. `sed`, `awk` et `uniq` restent sans règle Codex : pour `uniq`, une
règle de préfixe ne saurait garantir l’absence d’un argument désignant un fichier de sortie.
Une seconde exception explicite autorise les neuf lectures Git détaillées plus bas, afin
qu’un composé comme `rg --files src && git diff --check && lsof -ti :3001` soit allow
segment par segment, même si `lsof` demande une sortie du sandbox. `git fetch`, qui accède
au dépôt distant, est également autorisé pour les deux moteurs selon l’arbitrage décrit plus
bas. Les autres lectures Git, utilitaires et écritures relatives continuent de cibler Claude seul.
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
| `rtk proxy cat README.md` | aucune règle du socle | allow |
| `rtk proxy cat .env` | aucune règle du socle | deny |

Le socle déclare les deux préfixes ci-dessus. Une couche de dépôt en bénéficie sans les redéclarer :
`npm run test:gate` génère aussi `rtk npm run test:gate` et `rtk proxy npm run test:gate` avec la
même décision et les mêmes moteurs. Aucun `rtk npm run` générique n’est autorisé.
Les règles propres `rtk grep`, `rtk read`, `rtk ls`, `rtk diff`,
`rtk gain`, `rtk discover` et `rtk session` sont autorisées pour Claude seul. Leurs formes
préfixées sont également générées, sans expansion récursive. Les collisions de même motif et
décision sont dédupliquées dans les sorties (exemples Codex réunis) ; des décisions différentes
restent soumises à la priorité habituelle. Aucun `rtk` ou `rtk proxy` libre n’est autorisé.
Le miroir de l’entrée `grep` Codex ajoute désormais un allow `rtk grep` séparé ; le programme
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
réservé à `engines: ["claude"]`, permet les formes exactes de `uniq` et l’exception ci-dessous.
Il conserve les assertions `match` / `notMatch` et suit les miroirs ; aucune règle Codex n’est
inventée pour représenter un motif Claude.

**Exception assumée : `git -C *` suivi d’une commande de la liste fermée** : `status`, `diff`,
`log`, `show`, `rev-parse`, `branch --list`, `ls-files`, `grep`, `merge-tree`, `worktree list`,
`add`, `commit`, `fetch`. Chaque commande
possède un motif sans suffixe et un motif acceptant des arguments. Les chemins des worktrees
ne sont pas énumérés. Aucun allow générique `git -C *` n’est produit.

Un joker peut englober une sous-commande : les gardes `ask` couvrent donc `push`, `pull`,
`merge`, `rebase`, `reset`, `restore`, `checkout`, `switch`, `stash`,
`clean`, `rm`, `tag`, les mutations de `branch`, `worktree` et `remote`, `config` et `gc`.
Les écritures apparentées (`init`, `mv`, `apply`, `cherry-pick`, `revert`, mutations d’objets
et maintenance) sont également gardées, ainsi que le lancement du pager de `git grep`.
Le générateur refuse cette exception si une garde obligatoire manque. Les tests injectent
`git push`, `gh pr merge`, `rm` et chaque mutation devant chaque suffixe autorisé, y compris
`git -C /x push origin status`, sous RTK aussi : le résultat doit être `prompt` ou `forbidden`.
Les autres motifs allow avec joker interne restent interdits. La garde `merge` respecte la
frontière du mot pour ne pas bloquer la lecture `merge-tree`.

La parité ajoutée pour `add`, `commit` et `fetch` concerne **Claude seulement** : `git add`
et `git -C <chemin> add`, par exemple, sont allow et portent les mêmes gardes d’options libres.
Les gardes génériques `git -C … add`, `commit`, `fetch` sont retirées ; les gardes de
`worktree add` et `remote add` restent en ask. **Aucune règle Codex pour `git -C`** : un préfixe
littéral ne peut pas sauter un chemin variable, et autoriser `git -C` entier ouvrirait les
mutations. Cette limite vaut aussi pour les miroirs RTK.

`git add` et `git commit` restent allow pour les deux moteurs. Leur `residualRisk` précise
que `--edit` lance l’éditeur configuré et que `git commit --gpg-sign` lance le programme de
signature configuré. Le user accorde sa confiance à ces outils préconfigurés comme aux hooks
déjà exécutés par commit. Ces variantes ne reçoivent pas de garde demandant un accord.

`git fetch` est allow pour les deux moteurs : il lit le dépôt distant et modifie les objets
et références locaux, sans publication distante (`local-reversible`). Claude demande un
accord pour `--upload-pack` et `-c`, à toute position couverte par les gardes textuelles, avec
ou sans `-C`. **Codex conserve le risque `--upload-pack`**, y compris `--upload-pack=<programme>` :
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
(argument séparé ou `=valeur`) sont refusés ;
les motifs plus larges pouvant attraper `--pre-glob` ou `--output-indicator-new` demandent
un accord. Les lectures Git directes comme `diff` et `log` gardent leurs deny sur
`--ext-diff` et `--upload-pack` ; le pager de `git grep` garde aussi son deny direct.
Les motifs `-c*` Git, parfois des options de lecture légitimes, sont en ask.
Après `git -C`, `--exec-path*` et `--config-env*` sont aussi en ask, quelle que soit leur
position parmi les arguments suivants ; une sous-chaîne dans un chemin ne les déclenche pas.
Les gardes d’options partagées par les formes `git -C`, ainsi que celles de `add`, `commit`
et `fetch` directs, sont toutes en ask : `--output`, `--ext-diff`, `--upload-pack`, `-c`,
`--exec-path`, `--config-env`. Elles peuvent rencontrer un argument légitime, par exemple
un message de commit parlant de `--output=…`. Le générateur exige ces ask pour autoriser les
motifs `git -C` ; un deny ne peut pas les remplacer.

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
| `git -C …`, formes exactes `uniq` | Joker interne ou fin d’arguments non exprimables : aucune règle Codex. |
| `git branch --list` | Aucune règle Codex : `--no-list -D` annulerait la lecture et permettrait une suppression. |
| Lectures Git avec `--ext-diff`, `--output` ; `git grep -O` / `--open-files-in-pager` | Risques d’exécution et d’écriture acceptés explicitement dans les allow Codex ; aucune exclusion d’options libres. |
| `.env*`, options sensibles d’`awk`, `sed`, `file` | Gardes textuelles propres à Claude ; aucune règle Codex pour ces trois programmes. Les filtres Codex autorisés ne filtrent pas les chemins `.env*`. |
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

## Arbitrage des variantes dangereuses

Question par préfixe : **la variante peut-elle nuire seule, sans étape préalable déjà soumise à accord ?**

- Sous-préfixe identifiable : conserver l’autorisation et ajouter une règle plus stricte,
  par exemple `npm audit` en `allow`, `npm audit fix` en `prompt`.
- Configuration préalable nécessaire, ou effet local réversible accepté : expliquer la limite
  dans le champ optionnel `residualRisk`. `npx tsc --noEmit false` reste ainsi autorisé.
- Option libre suffisante pour exécuter une commande ou écrire hors dépôt : aucun `allow`
  générique Codex par défaut. Les filtres explicitement convenus ci-dessus constituent une
  exception documentée, comme les lectures Git convenues et `git fetch --upload-pack` ;
  `sed` et `awk` restent confinés.

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
| Lectures Git | Neuf préfixes explicites Codex avec risques acceptés ; lectures Claude avec gardes. `git -C` reste Claude seul. |
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
