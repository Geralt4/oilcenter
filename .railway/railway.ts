// Railway settings for the hosted preview — replaces railway.json (Config as Code, retired 2026-12-01).
// Railway never reads this file on deploy: `railway config apply` pushes it to the project.
// Workflow and safety rules: README.md → "Hosted preview (Railway)".
//
// This file describes the WHOLE project, and omitting something means deleting it. The volume,
// its mount and every variable must therefore stay listed, even though nothing about them is
// configured here. `railway config plan` must never show a "Delete" line or a change to
// web-volume: that volume holds the shop database.
import { defineRailway, preserve, project, service, volume } from "railway/iac";

// preserve() keeps whatever value is stored on Railway, so secrets never enter git. For a
// variable that does not exist there yet it does nothing.
const keep = (...names: string[]) => Object.fromEntries(names.map((name) => [name, preserve()]));

export default defineRailway(() => {
  // SQLite database, admin uploads, e-mail outbox and backups.
  const webVolume = volume("web-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 500,
  });

  const web = service("web", {
    // Explicit, so a missing Dockerfile fails the build instead of falling back to Railpack.
    // The path defaults to ./Dockerfile.
    build: { builder: "DOCKERFILE" },
    // 180 s: the container migrates, seeds and patches the database before Next.js starts.
    healthcheck: "/api/health",
    healthcheckTimeout: 180,
    // `railway config migrate` drops the restart policy; the raw deploy block keeps it.
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    replicas: { sfo: 1 },
    volumeMounts: { "/app/data": webVolume },
    // The public hostnames (DOMAIN.md). The port is mandatory: a bare string defaults to 8080 in the SDK, and the
    // app listens on 3000. The generated *.up.railway.app address is never listed here. A custom domain added in
    // the dashboard or with `railway domain` but missing from this list is DELETED by the next apply.
    domains: [
      { domain: "www.oilcenter.gr", port: 3000 },
      { domain: "oilcenter.gr", port: 3000 },
    ],
    // Every variable of .env.example that can be set on Railway, whether or not it is set today.
    // A variable that is set there but missing here is DELETED by the next apply — losing
    // SITE_PASSWORD that way would silently open the pre-launch password gate.
    env: keep(
      "PORT",
      "ADMIN_EMAIL",
      "ADMIN_PASSWORD",
      "AUTH_SECRET",
      "SITE_URL",
      "SITE_USER",
      "SITE_PASSWORD",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_SECURE",
      "SMTP_USER",
      "SMTP_PASS",
      "MAIL_FROM",
      "ORDERS_NOTIFY_EMAIL",
      "VIVA_ENV",
      "VIVA_CLIENT_ID",
      "VIVA_CLIENT_SECRET",
      "VIVA_SOURCE_CODE",
      "VIVA_MERCHANT_ID",
      "VIVA_API_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ),
  });

  return project("oilcenter", {
    resources: [web, webVolume],
  });
});
