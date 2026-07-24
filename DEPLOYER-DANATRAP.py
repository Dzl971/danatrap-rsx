#!/usr/bin/env python3
"""Déploiement simplifié de DanaTrap RSX vers GitHub puis Render.

Aucune dépendance Python externe n'est nécessaire.
Le script ajoute les fichiers modifiés, crée un commit, synchronise la branche
et pousse vers GitHub. Render redéploie ensuite automatiquement les services
liés à cette branche.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent
DEFAULT_BRANCH = "main"
DEFAULT_REMOTE = "origin"
SITE_URL = "https://danatrap-rsx-site.onrender.com"
API_HEALTH_URL = "https://danatrap-rsx-api.onrender.com/health"

TEXT_SUFFIXES = {
    ".txt", ".md", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json",
    ".yaml", ".yml", ".env", ".bat", ".cmd", ".ps1", ".py", ".html",
    ".css", ".sql", ".toml", ".ini", ".cfg", ".xml",
}

# Détection prudente de secrets réels. Les placeholders « ... » ne sont pas bloqués.
SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("clé Supabase secrète", re.compile(r"sb_secret_[A-Za-z0-9_-]{16,}")),
    ("secret OAuth Google", re.compile(r"GOCSPX-[A-Za-z0-9_-]{16,}")),
    ("refresh token Google", re.compile(r"1//[A-Za-z0-9._-]{20,}")),
    (
        "variable privée renseignée",
        re.compile(
            r"(?im)^\s*(?:SUPABASE_SERVICE_ROLE_KEY|GOOGLE_CLIENT_SECRET|"
            r"GOOGLE_REFRESH_TOKEN|FILE_SIGNING_SECRET)\s*[:=]\s*[\"']?"
            r"(?!\s*$|\.\.\.|TON_|VOTRE_|CHANGEME|EXEMPLE|<)[^\s\"'#]{12,}"
        ),
    ),
)


class DeployError(RuntimeError):
    """Erreur contrôlée affichable à l'utilisateur."""


def setup_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass


def find_git() -> str:
    found = shutil.which("git")
    if found:
        return found

    candidates: list[Path] = []
    program_files = os.environ.get("ProgramFiles")
    local_app_data = os.environ.get("LOCALAPPDATA")

    if program_files:
        candidates.extend(
            [
                Path(program_files) / "Git" / "cmd" / "git.exe",
                Path(program_files) / "Git" / "bin" / "git.exe",
            ]
        )

    if local_app_data:
        github_desktop = Path(local_app_data) / "GitHubDesktop"
        candidates.extend(
            sorted(
                github_desktop.glob("app-*/resources/app/git/cmd/git.exe"),
                reverse=True,
            )
        )
        candidates.extend(
            sorted(
                github_desktop.glob("app-*/resources/app/git/mingw64/bin/git.exe"),
                reverse=True,
            )
        )

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    raise DeployError(
        "Git est introuvable. Installe Git for Windows ou vérifie que GitHub "
        "Desktop est installé, puis relance le fichier .bat."
    )


def run(
    command: list[str],
    *,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=capture,
            check=False,
        )
    except OSError as exc:
        raise DeployError(f"Impossible d'exécuter la commande : {exc}") from exc

    if check and result.returncode != 0:
        details = (result.stderr or result.stdout or "Erreur inconnue").strip()
        raise DeployError(details)
    return result


def git(git_exe: str, *args: str, capture: bool = False, check: bool = True):
    return run([git_exe, *args], capture=capture, check=check)


def ensure_repository(git_exe: str) -> None:
    result = git(git_exe, "rev-parse", "--show-toplevel", capture=True, check=False)
    if result.returncode != 0:
        raise DeployError(
            "Ce dossier n'est pas un dépôt Git. Place DEPLOYER-DANATRAP.py et "
            "DEPLOYER-DANATRAP.bat dans le dossier danatrap-rsx qui contient .git."
        )

    actual_root = Path(result.stdout.strip()).resolve()
    if actual_root != ROOT.resolve():
        raise DeployError(
            f"Le script doit être à la racine du dépôt Git. Racine détectée : {actual_root}"
        )


def current_branch(git_exe: str) -> str:
    result = git(git_exe, "branch", "--show-current", capture=True)
    branch = result.stdout.strip()
    if not branch:
        raise DeployError("Impossible de déterminer la branche Git actuelle.")
    return branch


def changed_paths(git_exe: str) -> list[Path]:
    result = git(
        git_exe,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        capture=True,
    )
    entries = result.stdout.split("\0")
    paths: list[Path] = []
    for entry in entries:
        if not entry:
            continue
        # Format : XY<espace>chemin. Pour un renommage, le chemin final suit parfois.
        path_text = entry[3:] if len(entry) >= 4 else entry
        if " -> " in path_text:
            path_text = path_text.split(" -> ", 1)[1]
        candidate = (ROOT / path_text).resolve()
        try:
            candidate.relative_to(ROOT.resolve())
        except ValueError:
            continue
        paths.append(candidate)
    return paths


def scan_for_secrets(paths: Iterable[Path]) -> list[tuple[Path, str]]:
    findings: list[tuple[Path, str]] = []
    ignored_names = {".env.example", "config.example.js"}

    for path in paths:
        if not path.is_file() or path.name in ignored_names:
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES or path.stat().st_size > 2_000_000:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(content):
                findings.append((path, label))
                break
    return findings


def print_changes(git_exe: str) -> None:
    result = git(git_exe, "status", "--short", capture=True)
    print("\nFichiers détectés :")
    print(result.stdout.rstrip() or "  Aucun changement")


def confirm(question: str, *, default_yes: bool = True) -> bool:
    suffix = " [O/n] " if default_yes else " [o/N] "
    try:
        answer = input(question + suffix).strip().lower()
    except EOFError:
        return default_yes
    if not answer:
        return default_yes
    return answer in {"o", "oui", "y", "yes"}


def deploy(git_exe: str, message: str | None, assume_yes: bool) -> None:
    ensure_repository(git_exe)

    branch = current_branch(git_exe)
    if branch != DEFAULT_BRANCH:
        raise DeployError(
            f"Tu es sur la branche « {branch} ». Passe sur « {DEFAULT_BRANCH} » "
            "avant de déployer."
        )

    remote_check = git(
        git_exe,
        "remote",
        "get-url",
        DEFAULT_REMOTE,
        capture=True,
        check=False,
    )
    if remote_check.returncode != 0:
        raise DeployError("Le dépôt distant GitHub « origin » n'est pas configuré.")

    paths = changed_paths(git_exe)
    if not paths:
        print("\nAucun fichier modifié : rien à envoyer vers GitHub ou Render.")
        return

    findings = scan_for_secrets(paths)
    if findings:
        print("\n⛔ Déploiement bloqué : un secret semble présent dans les fichiers suivants :")
        for path, label in findings:
            print(f"  - {path.relative_to(ROOT)} ({label})")
        print(
            "\nRetire ces valeurs du dossier du projet ou place-les dans les "
            "variables privées Render. Le script refuse de les envoyer sur GitHub."
        )
        raise DeployError("Secret potentiel détecté.")

    print_changes(git_exe)
    if not assume_yes and not confirm("Continuer le déploiement ?"):
        print("Déploiement annulé.")
        return

    if not message:
        default_message = "Mise à jour DanaTrap RSX - " + dt.datetime.now().strftime(
            "%Y-%m-%d %H:%M"
        )
        try:
            message = input(f"Message du déploiement [{default_message}] : ").strip()
        except EOFError:
            message = ""
        message = message or default_message

    print("\n[1/5] Ajout des modifications…")
    git(git_exe, "add", "-A")

    staged = git(git_exe, "diff", "--cached", "--quiet", check=False)
    if staged.returncode == 0:
        print("Aucune modification à valider après l'ajout.")
        return
    if staged.returncode not in (0, 1):
        raise DeployError("Impossible de vérifier les modifications préparées.")

    print("[2/5] Création du commit…")
    git(git_exe, "commit", "-m", message)

    print("[3/5] Synchronisation avec GitHub…")
    pull = git(
        git_exe,
        "pull",
        "--rebase",
        DEFAULT_REMOTE,
        branch,
        capture=True,
        check=False,
    )
    if pull.returncode != 0:
        details = (pull.stderr or pull.stdout).strip()
        raise DeployError(
            "La synchronisation a échoué. Aucun fichier n'a été écrasé. "
            "Ouvre GitHub Desktop pour résoudre un éventuel conflit, puis relance.\n"
            + details
        )

    print("[4/5] Envoi vers GitHub…")
    push = git(
        git_exe,
        "push",
        DEFAULT_REMOTE,
        branch,
        capture=True,
        check=False,
    )
    if push.returncode != 0:
        details = (push.stderr or push.stdout).strip()
        raise DeployError(
            "Le push GitHub a échoué. Vérifie ta connexion et ton authentification "
            "GitHub, puis relance.\n" + details
        )

    commit_sha = git(git_exe, "rev-parse", "--short", "HEAD", capture=True).stdout.strip()
    print("[5/5] Déploiement transmis à Render.")
    print("\n✅ Déploiement envoyé avec succès.")
    print(f"Commit : {commit_sha} — {message}")
    print(
        "Render détecte automatiquement ce push et redéploie le site et l'API. "
        "Le site statique prend généralement quelques minutes."
    )
    print(f"\nSite : {SITE_URL}")
    print(f"API  : {API_HEALTH_URL}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Commit, push GitHub et déclenchement automatique de Render."
    )
    parser.add_argument(
        "message",
        nargs="?",
        help="Message du commit. Sans valeur, le script le demande.",
    )
    parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Ne demande pas de confirmation avant le déploiement.",
    )
    return parser.parse_args()


def main() -> int:
    setup_console()
    print("=" * 62)
    print("  DanaTrap RSX — Déploiement automatique GitHub → Render")
    print("=" * 62)
    try:
        args = parse_args()
        git_exe = find_git()
        deploy(git_exe, args.message, args.yes)
        return 0
    except KeyboardInterrupt:
        print("\nDéploiement annulé.")
        return 130
    except DeployError as exc:
        print(f"\n❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
