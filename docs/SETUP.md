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
2. Paste each **Price ID** (`price_…`) into **Admin → Products** and tick *Active*.
3. In Stripe, add the webhook endpoint `https://<your-domain>/api/stripe/webhook` with
   the event `checkout.session.completed`.
4. Set the secrets:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY       # sk_test_… then sk_live_…
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_…
   ```
5. Turn on **Admin → Settings → Store → Store enabled**.

> Before going live, add account linking (phase 4 in SCOPE.md) so purchases survive a
> cleared browser, and decide between Stripe Tax and a merchant of record for VAT.

## 4. Local admin

`wrangler dev` with `DEV_ADMIN_EMAIL` set in `.dev.vars` lets you open `/admin` on
`localhost` without Access. This bypass only works when the request hostname is
`localhost` or `127.0.0.1`.
