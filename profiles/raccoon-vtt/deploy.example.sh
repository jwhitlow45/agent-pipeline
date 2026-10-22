#!/bin/zsh
# The raccoon-vtt deploy, with every private value replaced by a placeholder. The real script lives
# outside the repository, since it names the server, and pipeline.local.json points deploy.command at it.
#
# usage: deploy.sh <name> <jj rev for main> <the server's current HEAD sha>
#
# The server has no GitHub key, so the release travels as a git bundle. Each step prints what
# `pipeline deploy record` needs: the backup's name, health, restarts, the room load check, HTTP codes.
set -e
NAME=$1; REV=$2; PREV=$3
SCRATCH=<scratch folder>
APP='<app folder on the server>'

cd <main workspace>
# The server must be where the last deploy left it, with a clean tree.
H=$(ssh <deploy-host> "cd $APP && git status --short | head -3; git rev-parse HEAD")
echo "server: $H"
[ "$H" = "$PREV" ] || { echo "server HEAD is not $PREV or tree dirty"; exit 1; }

jj bookmark set main -r $REV 2>&1 | tail -1
jj git push --bookmark main 2>&1 | tail -1
git fetch -q origin main
# After jj moves main from another workspace, git's refs/heads/main can lag behind, and the bundle
# would ship the old main. Compare it with origin/main before bundling.
[ "$(git rev-parse refs/heads/main)" = "$(git rev-parse origin/main)" ] || git update-ref refs/heads/main $(git rev-parse origin/main)
echo "origin/main $(git rev-parse origin/main)"
git bundle create -q $SCRATCH/$NAME.bundle $PREV..main
scp -q $SCRATCH/$NAME.bundle <deploy-host>:/tmp/app-$NAME.bundle

# Backup first, then pull the bundle and rebuild.
ssh <deploy-host> "cd $APP && D=\$(date -u +%Y%m%d-%H%M) && docker compose -f docker-compose.server.yml exec -T postgres pg_dump -U <db user> -d <db name> --format=custom > backups/db-\$D-before-$NAME.dump && ls -l backups/db-\$D-before-$NAME.dump | awk '{print \$5, \$9}' && git pull -q --ff-only /tmp/app-$NAME.bundle main && git rev-parse HEAD && docker compose -f docker-compose.server.yml up -d --build 2>&1 | tail -1"

# Health, restarts, and the app's own load check: every stored room loads and replays.
ssh <deploy-host> "cd $APP && for i in \$(seq 1 60); do s=\$(docker inspect -f '{{.State.Health.Status}}' <app container>); [ \"\$s\" = healthy ] && break; sleep 2; done; echo \$s; docker inspect -f 'restarts={{.RestartCount}}' <app container> && docker compose -f docker-compose.server.yml exec -T <app service> node --input-type=module -" <<'EOF'
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
EOF

# Warnings and errors in the last five minutes of logs, then tidy up.
ssh <deploy-host> "cd $APP && docker compose -f docker-compose.server.yml logs --since 5m <app service> 2>&1 | grep -E '\"level\":(40|50|60)' | head -5; echo '-- logs end'; rm -f /tmp/app-$NAME.bundle"
rm -f $SCRATCH/$NAME.bundle

# The HTTP checks.
for u in / /docs /docs/dm-guide; do curl -s -o /dev/null -w "%{http_code} " https://<private-domain>$u; done; echo
