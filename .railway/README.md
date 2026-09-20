# Railway configuration

`railway.ts` holds the Railway settings of the hosted preview (builder, health check, restart policy, volume
mount). Railway does not read it on deploy — the Railway CLI compares it with the live project and pushes the
difference. The full workflow and the safety rules are in the main `README.md` → "Hosted preview (Railway)".

One-time setup (the SDK lives here, not in the app's `package.json`, so it never reaches the production image):

```bash
npm install --prefix .railway
```

Then, from the repository root:

```bash
railway config plan     # read-only preview of what would change
railway config apply    # shows the same plan, asks, then changes the live service settings
```

`railway.ts` describes the whole project: anything left out of it is deleted on apply. A plan that shows a
`Delete` line, or any change to `web-volume` (the shop database), must not be applied — and never pass
`--confirm-destructive`.
