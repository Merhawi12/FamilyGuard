# Operations

## Where things are

| Thing                | Location                                                       |
| -------------------- | -------------------------------------------------------------- |
| API logs             | CloudWatch `/parentix/<env>/api`                                |
| Database logs        | CloudWatch `/aws/rds/instance/<id>/postgresql`                  |
| Container metrics    | CloudWatch Container Insights, cluster `parentix-<env>`         |
| Database credentials | Secrets Manager `parentix/<env>/db` (AWS-managed, rotatable)    |
| Application secrets  | Secrets Manager `parentix/<env>/app`                            |
| Images               | ECR `parentix-api-<env>`, tagged with the commit SHA            |

Logs are one JSON object per line, so Logs Insights can query fields directly:

```
fields @timestamp, level, message, requestId, error
| filter level = "error"
| sort @timestamp desc
| limit 50
```

Every response carries `X-Request-Id`; the same value appears as `requestId` on
any 5xx log line, which is the fastest way to get from a user report to a cause.

## Health

| Endpoint      | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `/api/health` | The process is up. This is what the ALB checks.           |
| `/api/ready`  | The process is up **and** the database answers.           |

A task failing `/api/health` is replaced automatically. `/api/ready` returning
503 while `/api/health` is fine points at the database or its security group,
not the application.

## Secrets

| Secret                 | Rotatable | Consequence of rotating                                |
| ---------------------- | --------- | ------------------------------------------------------ |
| `JWT_SECRET`           | Yes       | Every session is invalidated; all users must sign in again |
| `FIELD_ENCRYPTION_KEY` | **No**    | Every encrypted column becomes permanently unreadable   |
| `STRIPE_*`             | Yes       | Update in the Stripe dashboard first, then here         |
| Database password      | Yes       | Rotate through Secrets Manager, then restart the service |

After changing any secret, force a new deployment so tasks pick it up:

```bash
aws ecs update-service --cluster parentix-prod \
  --service parentix-api-prod --force-new-deployment
```

## Migrations

Migrations run automatically as each API task starts, wrapped in a Postgres
advisory lock so simultaneously starting tasks cannot race.

To inspect or drive them by hand:

```bash
npm --prefix services/api run migrate:status
npm --prefix services/api run migrate
npm --prefix services/api run migrate:down   # reverts the most recent one
```

Writing a new one: add `src/db/migrations/000N-description.js` exporting `up` and
`down`, both taking a Sequelize `QueryInterface`. Make `up` idempotent — check
`describeTable` before adding a column — so a partially applied deploy can be
retried safely. Table *creation* does not belong in a migration; add the model
and `sync()` will create it.

Snapshot the database before releasing anything destructive:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier <id> \
  --db-snapshot-identifier pre-release-$(date +%Y%m%d%H%M)
```

## Scaling

The service scales on CPU (target 65%) and memory (target 75%), between
`minCapacity` and `maxCapacity` from `infrastructure/aws/lib/config.ts`.

**Running more than one task requires Redis.** Socket.IO events would otherwise
stay on the task that emitted them, and a parent connected elsewhere would
silently miss alerts. `redis.enabled` and `api.minCapacity` must be raised
together.

To change capacity, edit the config and redeploy the Api stack. For a temporary
bump:

```bash
aws ecs update-service --cluster parentix-prod \
  --service parentix-api-prod --desired-count 4
```

Autoscaling will pull that back to its own bounds; edit the config for anything
lasting.

## Common problems

**Tasks start and immediately stop.** Read the log group. A configuration
problem is explicit — the API refuses to start with a message naming the missing
variable, rather than serving traffic with an insecure default. The usual cause
is an empty `FIELD_ENCRYPTION_KEY` in the application secret.

**503 from CloudFront on `/api/*`.** No healthy targets. Check
`aws ecs describe-services` for `runningCount`, then the task logs.

**Realtime works for some parents and not others.** Almost always Redis: more
than one task with `REDIS_URL` unset. Confirm the variable is populated in the
task definition.

**Email is not arriving.** Check `EMAIL_PROVIDER` is `ses` and that SES has
production access — a sandboxed account silently drops mail to unverified
addresses. With `EMAIL_PROVIDER=none` the API logs verification codes and reset
links instead of sending them, which is the intended local behaviour but wrong
in production.

**Uploads fail with 503.** `STORAGE_PROVIDER` or `S3_BUCKET` is unset. A 403 on
the `PUT` instead means the pre-signed URL expired (default 5 minutes) — the
client should request a fresh one.

**A user cannot sign in after a password reset.** Expected: a reset revokes
every existing session by design.

## Staff accounts

There is no sign-up for staff. Create or promote an account with:

```bash
node services/api/scripts/create-admin.js --email person@example.com --name "Name"
node services/api/scripts/create-admin.js --email person@example.com --role support
```

In AWS, run it as a one-off ECS task on the API task definition (see
`docs/DEPLOYMENT.md` §1.6); the generated password appears in that task's log
stream once. Re-running promotes an existing account without touching its
password unless `--password` is passed.

To demote someone, change their role from the Admin Dashboard rather than with
this script, so the change is captured in the audit log.

## Access review

The Admin Dashboard is staff-only and marked `noindex`. Two independent gates:
the API checks role and permission on each call, and the console refuses to
mount for a non-staff token.

Audit logs (`/api/audit`, surfaced in the console) record authentication events,
role changes, plan changes and force-logouts. Review them after any staff
offboarding, and revoke the departing account's sessions:

```
Admin Dashboard → Sessions → Force logout
```
