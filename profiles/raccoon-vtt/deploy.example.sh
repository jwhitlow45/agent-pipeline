#!/bin/zsh
# The raccoon-vtt deploy, with every private value replaced by a placeholder. The real script lives
# outside the repository, since it names the server, and pipeline.local.json points deploy.command at it.
#
# usage: deploy.sh <name> <jj rev to deploy> <the server's current HEAD sha> [run]
#
# It asks the pipeline first, deploys the exact local commit, checks the server, and only then moves
# main on GitHub. A fix for a hole that is live on the server is never published before the server
# runs it, and a deploy that fails its checks never reaches main. The server has no GitHub key, so
# the release travels as a git bundle built from the local commit. Each step prints what
# `pipeline deploy record` needs: the backup's name, health, restarts, the room load check, HTTP codes.
# pipefail, here and on the server, so a failing command before `| tail -1` fails the deploy, and the
# running container's image must change, so a failed build never passes the checks on the old one.
set -e -o pipefail
NAME=$1; REV=$2; PREV=$3; RUN=${4:-$1}
SCRATCH=<scratch folder>
APP='<app folder on the server>'

cd <main workspace>
# The pipeline's own check of this exact commit. It exits 1 and says why when anything is missing.
SHA=$(jj log --no-graph -r "$REV" -T commit_id)
pipeline deploy check --run "$RUN" --tip "$SHA" --name "$NAME" --prev "$PREV"

# The server must be where the last deploy left it, with a clean tree.
H=$(ssh <deploy-host> "cd $APP && git status --short | head -3; git rev-parse HEAD")
echo "server: $H"
[ "$H" = "$PREV" ] || { echo "server HEAD is not $PREV or tree dirty"; exit 1; }

# The bundle holds the local commit itself, under a ref of its own, never main as GitHub has it.
git update-ref "refs/deploy/$NAME" "$SHA"
git bundle create -q "$SCRATCH/$NAME.bundle" "refs/deploy/$NAME" "^$PREV"
git update-ref -d "refs/deploy/$NAME"
scp -q "$SCRATCH/$NAME.bundle" <deploy-host>:/tmp/app-$NAME.bundle

# Backup first, then move to the bundle's commit, rebuild, and check the container was replaced.
ssh <deploy-host> "set -o pipefail; cd $APP && OLD=\$(docker inspect -f '{{.Image}}' <app container>) && D=\$(date -u +%Y%m%d-%H%M) && docker compose -f docker-compose.server.yml exec -T postgres pg_dump -U <db user> -d <db name> --format=custom > backups/db-\$D-before-$NAME.dump && ls -l backups/db-\$D-before-$NAME.dump | awk '{print \$5, \$9}' && git fetch -q /tmp/app-$NAME.bundle refs/deploy/$NAME && git merge -q --ff-only FETCH_HEAD && [ \"\$(git rev-parse HEAD)\" = $SHA ] && git rev-parse HEAD && docker compose -f docker-compose.server.yml up -d --build 2>&1 | tail -1 && NEW=\$(docker inspect -f '{{.Image}}' <app container>) && { [ \"\$OLD\" != \"\$NEW\" ] || { echo 'image unchanged: the build did not replace the running container'; exit 1; }; } && echo image replaced"

# Health, restarts, and the app's own load check: every stored room loads and replays.
ssh <deploy-host> "cd $APP && for i in \$(seq 1 60); do s=\$(docker inspect -f '{{.State.Health.Status}}' <app container>); [ \"\$s\" = healthy ] && break; sleep 2; done; echo \$s; [ \"\$s\" = healthy ] && docker inspect -f 'restarts={{.RestartCount}}' <app container> && docker compose -f docker-compose.server.yml exec -T <app service> node --input-type=module -" <<'EOF2'
import { getPool } from "/app/server/db.ts";
import { loadRoom } from "/app/server/rooms/persistence.ts";
const pool = getPool(process.env.DATABASE_URL);
const { rows } = await pool.query("select id from rooms order by id");
let ok = 0, bad = [];
for (const r of rows) {
  try { const x = await loadRoom(pool, r.id, (seq, reason) => bad.push(r.id + " replay " + seq + " " + reason)); x ? ok++ : bad.push(r.id + " missing"); }
  catch (e) { bad.push(r.id + " FAIL " + (e instanceof Error ? e.message : String(e))); }
}
console.log("rooms ok", ok, "of", rows.length, bad.join(", "));
await pool.end();
if (bad.length) process.exit(1);
EOF2

# Warnings and errors in the last five minutes of logs, then tidy up.
ssh <deploy-host> "cd $APP && docker compose -f docker-compose.server.yml logs --since 5m <app service> 2>&1 | grep -E '\"level\":(40|50|60)' | head -5; echo '-- logs end'; rm -f /tmp/app-$NAME.bundle"
rm -f "$SCRATCH/$NAME.bundle"

# The HTTP checks. A code other than 2xx or 3xx stops the deploy before main moves.
codes=""
for u in / /docs /docs/dm-guide; do codes="$codes$(curl -s -o /dev/null -w '%{http_code}' https://<private-domain>$u) "; done
echo "$codes"
for c in ${=codes}; do [[ $c == [23]?? ]] || { echo "HTTP check failed: $c. main stays where it was."; exit 1; }; done

# Where the app reports the commit it runs, check that too before publishing, for example:
# [ "$(curl -s https://<private-domain>/<version path>)" = "$SHA" ] || { echo "the app does not run $SHA"; exit 1; }

# Only now, with the server running and checked, is the commit published.
jj bookmark set main -r "$SHA" 2>&1 | tail -1
jj git push --bookmark main 2>&1 | tail -1
