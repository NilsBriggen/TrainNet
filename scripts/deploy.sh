#!/usr/bin/env bash
# Ship this checkout to the server and wait until the timetable is served again.
# rsync carries the local uid 1000 over, which is a real user there, so ownership is reset after every copy.
# The server comes from the environment or .env.deploy (not in git): TRAINNET_HOST=user@host, optionally TRAINNET_SSH_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.deploy ] && . ./.env.deploy
HOST=${TRAINNET_HOST:?set TRAINNET_HOST=user@host, e.g. in .env.deploy}
SSH=(ssh -o BatchMode=yes)
[ -n "${TRAINNET_SSH_KEY:-}" ] && SSH+=(-i "$TRAINNET_SSH_KEY")
DIR=/root/trainnet
bun test
rsync -az --delete -e "${SSH[*]}" --exclude node_modules --exclude data --exclude .env --exclude .env.deploy --exclude .claude --exclude .git ./ "$HOST:$DIR/"
"${SSH[@]}" "$HOST" "cd $DIR && chown -R root:root . && chown -R 1000:1000 data && chmod 700 . && chmod 600 .env \
  && mkdir -p /mnt/storagebox/trainnet && docker compose up -d --build"
t0=$(date +%s)
until curl -sf -o /dev/null https://trainnet.briggen.dev/api/day; do
  (( $(date +%s) - t0 < 300 )) || { echo "timetable still not served after 5 min: docker logs trainnet"; exit 1; }
  sleep 3
done
echo "serving again after $(( $(date +%s) - t0 )) s"
