#!/usr/bin/env bash
#
# rpogorov portfolio — one-command local dev setup.
#
# Clones the site (astro-migration branch) and the content vault side by side,
# wires the 4 content symlinks the build expects, and installs deps.
#
# Usage:
#   bash setup-local.sh [target-dir]      # default: ./rpogorov-dev
#
# Vault repo defaults to SSH. If you don't have GitHub SSH set up, run with:
#   VAULT_REPO=https://github.com/RomanPogorov/obsidianVault.git bash setup-local.sh
#
set -euo pipefail

WORKDIR="${1:-$(pwd)/rpogorov-dev}"
SITE_REPO="${SITE_REPO:-https://github.com/RomanPogorov/rpogorov.git}"
VAULT_REPO="${VAULT_REPO:-git@github.com:RomanPogorov/obsidianVault.git}"
BRANCH="${BRANCH:-astro-migration}"

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

# --- node version check (warn only) ---
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".").map(Number)[0]')"
  NODE_MINOR="$(node -p 'process.versions.node.split(".").map(Number)[1]')"
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    warn "Node $(node -v) detected — the site needs >= 22.12. Upgrade if the build complains."
  else
    ok "Node $(node -v)"
  fi
else
  warn "node not found — install Node >= 22.12 (e.g. via nvm) before running the dev server."
fi

mkdir -p "$WORKDIR"
cd "$WORKDIR"
say "Workspace: $WORKDIR"

# --- 1. site repo (astro-migration) ---
if [ -d rpogorov/.git ]; then
  ok "rpogorov already cloned — syncing $BRANCH"
  git -C rpogorov fetch origin "$BRANCH"
  git -C rpogorov checkout "$BRANCH"
  git -C rpogorov pull --ff-only || warn "couldn't fast-forward rpogorov (local changes?) — skipping pull"
else
  say "Cloning site → rpogorov ($BRANCH)"
  git clone -b "$BRANCH" "$SITE_REPO" rpogorov
fi

# --- 2. content vault ---
if [ -d obsidianVault/.git ]; then
  ok "obsidianVault already cloned — pulling"
  git -C obsidianVault pull --ff-only || warn "couldn't fast-forward obsidianVault — skipping pull"
else
  say "Cloning vault → obsidianVault"
  git clone "$VAULT_REPO" obsidianVault
fi

# --- 3. content symlinks → local vault ---
VAULT_ABS="$WORKDIR/obsidianVault"
CONTENT="$WORKDIR/rpogorov/site/src/content"
mkdir -p "$CONTENT"
link() {
  local name="$1" target="$2"
  if [ ! -e "$VAULT_ABS/$target" ]; then
    warn "vault path missing: $target (skipped — check the vault repo)"
    return
  fi
  rm -rf "$CONTENT/$name"
  ln -s "$VAULT_ABS/$target" "$CONTENT/$name"
  printf '    %-12s → obsidianVault/%s\n' "$name" "$target"
}
say "Wiring content symlinks:"
link cases        portfolio/cases
link articles     portfolio/articles
link companies    portfolio/company/cases
link right-panel  portfolio/right-panel

# --- 4. install deps ---
say "Installing dependencies (rpogorov/site)…"
cd "$WORKDIR/rpogorov/site"
npm install

printf '\n'
ok "Setup complete."
cat <<EOF

Start the dev server:
  cd "$WORKDIR/rpogorov/site"
  npm run dev
  → http://localhost:4321/rpogorov-dev/app/

Edit source in rpogorov/site/ ; case/article content in obsidianVault/portfolio/.
Live site builds from the 'astro-migration' branch — push there, not main.
EOF
