#!/bin/zsh
cd "${0:A:h}" || exit 1
if [[ ! -d node_modules ]]; then
  npm ci || exit 1
fi
if ! curl --silent --fail http://127.0.0.1:4318/api/bootstrap >/dev/null; then
  (sleep 2; open http://127.0.0.1:4318) &
  npm run writer
else
  open http://127.0.0.1:4318
fi
