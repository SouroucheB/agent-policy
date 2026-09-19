# agent-policy

Une source JSON traduit les décisions de commandes pour **Codex et Claude Code**.
Le socle global est dans [`core-policy.json`](core-policy.json) ; chaque dépôt garde
sa propre couche et une copie autonome du générateur. Node.js ≥ 22, aucune dépendance
d’exécution ou de test, JavaScript sans casts. Les échanges et la documentation sont en français.

## Installer l’outil sur chaque machine

Depuis un checkout de cette PR, puis de la version relue et fusionnée :

```sh
npm test
mkdir -p .agent-tmp
npm pack --pack-destination .agent-tmp
npm install --global --ignore-scripts ./.agent-tmp/souroucheb-agent-policy-1.0.0.tgz
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
.codex/rules/project.rules           # sortie générée
.claude/settings.json                # entrées Bash générées ; autres permissions et clés conservées
```

`init` conserve les fichiers existants. `agent-policy init --upgrade` remplace la copie du
générateur par celle de l’outil installé, sans modifier un octet de `policy.json`.
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

`check --codex` ajoute, si `codex` est installé, un contrôle natif de chaque commande d’exemple
avec `codex execpolicy check`. Il n’exécute pas ces commandes. Codex absent n’est pas un échec ;
un binaire présent qui échoue ou donne un verdict différent l’est. Ce contrôle reste hors ligne
et isole l’état éventuel du processus Codex dans `.agent-tmp/`, ensuite nettoyé.

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
Un exemple dont la représentation textuelle Claude et les arguments Codex divergent est refusé.

`notMatch` est une **assertion de test**, jamais une exclusion. Ainsi, `rm -rf a b autre` correspond
bien au préfixe `rm -rf a b` ; le mettre dans `notMatch` est une erreur détectée avant génération.
Le socle interdit `rm` entier et n’accorde aucune règle `gh pr` générale.

| Source | Codex | Claude |
| --- | --- | --- |
| `allow` | `allow` | `permissions.allow` |
| `prompt` | `prompt` | `permissions.ask` |
| `forbidden` | `forbidden` | `permissions.deny` |

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
  générique, comme pour `rg`, `sed` et `git fetch`.

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

Ce champ optionnel ajoute seulement des `deny`. Il ne peut jamais assouplir la décision commune.
Les jokers sont des correspondances textuelles, potentiellement plus restrictives, sans analyse
exhaustive des options combinées. Le générateur ne prétend pas inspecter le contenu d’un wrapper.
Un script nommé doit lui-même refuser les arguments libres, le chargement de secrets non prévu et
les contournements ; sa revue fait partie de la PR qui ajoute son autorisation.

Choix explicites du socle après application de ce critère :

| Famille | Choix et limite |
| --- | --- |
| `git diff`, `git log` | Lectures autorisées avec fin des options : `git diff --`, `git diff --cached --`, `git log --`. `--ext-diff` dépendrait d’une configuration préalable, mais `--output` peut à lui seul écrire hors dépôt, d’où cette restriction. |
| Git local | Hooks, filtres et pager existants supposés de confiance ; aucun `git -c …` n’est autorisé globalement. La création de worktree est l’opération locale réversible expressément prévue. |
| `lsof` | `prompt` : certaines plateformes permettent `-Db<chemin>` pour écrire un cache. Une lecture portable fermée appartient à un wrapper de dépôt. |
| `npm audit` | `fix` canonique en `prompt`. Codex ne couvre pas `npm audit --json fix` avec ce sous-préfixe ; la limite est dans `residualRisk` et Claude dispose d’un refus supplémentaire. |
| `npx tsc --noEmit` | Compilateur installé et configuration locale de confiance nécessaires ; le préfixe ne vérifie pas leur présence. `npx` peut télécharger un paquet absent. Réactivation de l’émission acceptée comme effet local réversible. |
| `docker compose` | Lectures `ls`, `ps`, `images`, `top` distinguées des mutations. La lecture de configuration/environnement par Compose suppose un projet de confiance, explicitée dans `residualRisk`. |
| `npx supabase status` | `prompt` également, car `-o env` peut exposer les clés locales. |
| `curl` / `wget` | Interdiction conservatrice des commandes entières : un simple préfixe ne sait pas exprimer « seulement lorsqu’il est pipé vers un shell ». Cela bloque la source de ces pipelines ; utiliser un téléchargement contrôlé. |

Le socle ne contient aucun chemin, script CoproOS, SteamBoard ou autre point d’entrée de projet.
Il reprend les intentions de l’audit, sans recopier les anciennes autorisations larges.

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
les sauvegardes, le retour arrière et les échecs d’écriture. Aucun appel fournisseur, aucun
paquet téléchargé et aucune installation globale ne sont nécessaires.
