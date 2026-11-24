# Sourced by the simple-git-hooks preamble (SIMPLE_GIT_HOOKS_RC) or at the top of a hook.
# Git GUIs and non-login shells often start hooks without the user's PATH; find node here.

if ! command -v node >/dev/null 2>&1; then
  for delegate_node_dir in "${DELEGATE_NODE_BIN:-}" "$HOME/.local/node/bin" "$HOME/.volta/bin"; do
    if [ -n "$delegate_node_dir" ] && [ -x "$delegate_node_dir/node" ]; then
      PATH="$delegate_node_dir:$PATH"
      export PATH
      break
    fi
  done
  unset delegate_node_dir
fi

if ! command -v node >/dev/null 2>&1; then
  echo "git hook: node was not found on PATH or in \$HOME/.local/node/bin; set DELEGATE_NODE_BIN to the directory containing node." >&2
  exit 1
fi
