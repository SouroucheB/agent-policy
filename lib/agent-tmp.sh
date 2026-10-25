#!/usr/bin/env bash
# agent-policy agent-tmp v1.4.0 — copie autonome ; actualiser par agent-policy init --upgrade.
# Crée un dossier de travail sous .agent-tmp/ du checkout courant et affiche son chemin.
# Aucune purge ici : la rétention de sept jours relève d'une seule tâche de maintenance locale.
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
readonly AGENT_TMP_ROOT="$repository_root/.agent-tmp"

usage() {
  echo 'Usage: bash scripts/agent-policy/agent-tmp.sh create LABEL' >&2
  exit 2
}

[[ "$#" -eq 2 && "$1" = create && "$2" =~ ^[A-Za-z0-9._-]+$ ]] || usage
mkdir -p "$AGENT_TMP_ROOT"
directory="$AGENT_TMP_ROOT/$2-$(date +%Y%m%d%H%M%S)-$$"
mkdir "$directory"
printf '%s\n' "$directory"
