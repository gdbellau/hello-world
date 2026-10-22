# Setup

Everything here fits in the Cloudflare **free** plan and the Zero Trust **free** plan
(up to 50 users). Stripe charges only per transaction.

## 0. Repository

This project was scaffolded on a branch of `hello-world` because the build session
couldn't create new repos. To move it to a private `the_CABAL` repo:

```bash
# 1. Create an empty PRIVATE repo named the_CABAL on github.com (no README).
# 2. From a clone of hello-world:
git fetch origin claude/2080-tactical-game-8o06ft
git push git@github.com:gdbellau/the_CABAL.git origin/claude/2080-tactical-game-8o06ft:refs/heads/main
```

## 1. Cloudflare resources

```bash
npx wrangler login
npx wrangler d1 create cabal          # paste the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET   # long random string, e.g. `openssl rand -hex 32`
npm run deploy
```

To deploy on every push, connect the repo in **Workers & Pages → your Worker → Settings
→ Builds**, with build command `npm run build` and deploy command `npx wrangler deploy`.

## 2. Admin access (Cloudflare Zero Trust)

1. In the dashboard, open **Zero Trust**, pick a team name, and choose the **Free** plan.
   This gives you `<team>.cloudflareaccess.com`.
2. Go to **Access → Applications → Add → Self-hosted**.
   - Domain: your game hostname, path `admin`. Add a second entry with path `admin/*`.
   - Policy: **Allow** with **Emails** set to your address (or an email domain / GitHub org).
   - Identity provider: One-time PIN works out of the box. GitHub/Google are optional.
3. Copy the application's **Audience (AUD) tag**.
4. In `wrangler.jsonc`, set `ACCESS_TEAM_DOMAIN` to `<team>.cloudflareaccess.com` and
   `ACCESS_AUD` to the tag, then redeploy.
5. **Disable the `workers.dev` route** (Worker → Settings → Domains & Routes) and serve only
   on your custom domain, so `/admin` can't be reached around Access. The Worker
   rejects requests without a valid Access JWT either way.

## 3. Stripe (when you're ready to sell)

1. Create products and prices in the Stripe dashboard (start in **test mode**).
   - For the **Tip jar**, create a price with **"Customer chooses price"**
     (`custom_unit_amount`). Whatever the player pays is recorded from the session's
     `amount_total`.
2. Paste each **Price ID** (`price_…`) into **Admin → Products** and tick *Active*.
3. In Stripe, add the webhook endpoint `https://<your-domain>/api/stripe/webhook` with
   these events:

   | Event | What the Worker does |
   |---|---|
   | `checkout.session.completed` | Records the purchase with its `payment_intent`. Grants the entitlement if paid. Otherwise (bank debits and similar) records it as `pending`. |
   | `checkout.session.async_payment_succeeded` | Promotes a pending purchase to paid and grants the entitlement. |
   | `checkout.session.async_payment_failed` | Marks a pending purchase `failed`. |
   | `charge.refunded` | Full refund: marks the purchase `refunded` and revokes the entitlement unless another paid purchase still grants it. Partial refund: records the amount only. Bumps `refunds` / `refunded_cents`. |
   | `charge.dispute.created` | Marks the purchase `disputed` and revokes the entitlement under the same rule. Bumps `disputes`. |
   | `charge.dispute.closed` | If you **won**, restores the purchase to `paid` and grants the entitlement again. |

   Every handler is idempotent (keyed on the Checkout Session id and the purchase
   status), so Stripe retries and duplicate deliveries are safe. Each state change goes
   to the audit log with actor `system`. Admin-granted entitlements are never revoked
   by a refund.
4. Set the secrets:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY       # sk_test_… then sk_live_…
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_…
   ```
5. Set up email sign-in (section 3b). With **Admin → Settings → Store → Require account
   to purchase** on (the default), players must link an email before checkout. That
   email is passed to Stripe as `customer_email`.
6. Turn on **Admin → Settings → Store → Store enabled**.

> Before going live, decide between Stripe Tax and a merchant of record for VAT.

### Testing webhooks locally

```bash
stripe listen --forward-to localhost:8787/api/stripe/webhook   # prints a whsec_… for .dev.vars
stripe trigger checkout.session.completed
```

Or sign a payload by hand (with `STRIPE_WEBHOOK_SECRET=whsec_local` in `.dev.vars`):

```bash
BODY='{"type":"charge.refunded","data":{"object":{"id":"ch_1","payment_intent":"pi_1","amount":499,"amount_refunded":499,"refunded":true}}}'
T=$(date +%s); SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac whsec_local | sed 's/^.* //')
curl -s localhost:8787/api/stripe/webhook -H "Stripe-Signature: t=$T,v1=$SIG" -d "$BODY"
```

## 3b. Email sign-in (Resend)

Players start as an anonymous device identity. Linking an email with a one-time magic
link makes purchases survive a cleared browser and restores them on any device. Emails
go through [Resend](https://resend.com). The free tier allows 3,000 emails a month and
100 a day.

1. Create a Resend account and **add your domain** (Domains → Add). A subdomain such as
   `mail.<your-domain>` keeps it apart from your main mail.
2. Add the DNS records Resend shows (SPF `TXT`, DKIM, and optionally the bounce `MX`) in
   Cloudflare DNS, set to **DNS only**. Wait until Resend shows *Verified*.
3. Create an API key with **Sending access** for that domain only.
4. Set the secrets:
   ```bash
   npx wrangler secret put RESEND_API_KEY   # re_…
   npx wrangler secret put EMAIL_FROM       # e.g. THE CABAL <login@mail.your-domain>
   ```
5. Optional: add `APP_ORIGIN` to `vars` in `wrangler.jsonc` (e.g.
   `https://thecabal.example`) so emailed links always point at your canonical domain.
   Without it, links use the origin the request came in on.
6. Tune **Admin → Settings → Accounts**: link lifetime, hourly limits per address and
   per IP, the email subject, and the sign-in kill switch.

How it works:

- `POST /api/account/request-link {email}` always answers 200 with the same message, so
  it can't be used to find out who has an account. Only a SHA-256 of the token is
  stored. Requests are counted per email (hashed) and per `CF-Connecting-IP` in D1;
  over the limit, nothing is sent.
- The link opens `/?login=<token>`. The client calls `POST /api/account/verify`, which
  consumes the token atomically (single use, with expiry enforced in SQL). A new email
  is attached to the current anonymous player. If the email already has an account,
  the device signs in to it and the anonymous player's entitlements and purchases are
  **merged** into the account (audited as `account.merge`). The throwaway identity's
  credits and progress aren't merged, so free starting credits can't be farmed.
- `POST /api/account/logout` signs out **everywhere**. It bumps the account's
  `token_version`, which is part of the signed token, so every token for the account
  stops working. The response is a fresh anonymous identity for this device.
- Locally, without `RESEND_API_KEY`, the link is printed to the `wrangler dev` log. It
  is also returned as `devLink`, but only when the request host is `localhost` or
  `127.0.0.1`.

## 4. Local admin

`wrangler dev` with `DEV_ADMIN_EMAIL` set in `.dev.vars` lets you open `/admin` on
`localhost` without Access. This bypass only works when the request hostname is
`localhost` or `127.0.0.1`.
