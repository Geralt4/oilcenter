import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { AVAILABILITY_LABELS } from '@/lib/availability';
import type { OrderWithItems } from '@/lib/orders';
import { ORDER_STATUS_LABELS } from '@/lib/orders';
import { PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/pricing';
import { fullAddress, mapsDirectionsUrl, type ShopSettings } from '@/lib/settings';
import { siteUrl } from '@/lib/site-url';
import { formatDateTime, formatPrice } from '@/lib/utils';

/*
 * SMTP when SMTP_HOST is set; otherwise every message is written to DATA_DIR/outbox/*.html so the
 * whole order flow can be exercised locally. Sending never throws into the caller: a mail hiccup
 * must not fail a checkout. Failures are logged and the order timeline records what was sent.
 */

type Mail = { to: string; subject: string; html: string; replyTo?: string };

const from =() => process.env.MAIL_FROM || 'Oil Center <no-reply@oilcenter.gr>';

let transport: Transporter | null = null;
function smtp(): Transporter | null {
  if (!process.env.SMTP_HOST) return null;
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

export async function sendMail(mail: Mail): Promise<boolean> {
  // no recipient (no ORDERS_NOTIFY_EMAIL and no shop e-mail yet): the record is already saved, the mail is simply not sent
  if (!mail.to) {
    console.warn(`[mail] no recipient for "${mail.subject}" — set the shop e-mail in Ρυθμίσεις or ORDERS_NOTIFY_EMAIL`);
    return false;
  }
  try {
    const t = smtp();
    if (t) {
      await t.sendMail({ from: from(), to: mail.to, subject: mail.subject, html: mail.html, replyTo: mail.replyTo, text: mail.html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
      return true;
    }
    const dir = path.resolve(process.env.DATA_DIR || './data', 'outbox');
    await mkdir(dir, { recursive: true });
    const file = `${new Date().toISOString().replace(/[:.]/g, '-')}__${mail.to.replace(/[^a-z0-9@.]+/gi, '_')}.html`;
    await writeFile(path.join(dir, file), `<!-- to: ${mail.to} | subject: ${mail.subject} -->\n${mail.html}`);
    console.log(`[mail] SMTP not configured → wrote ${path.join('outbox', file)} ("${mail.subject}")`);
    return true;
  } catch (err) {
    console.error(`[mail] failed to send "${mail.subject}" to ${mail.to}:`, err);
    return false;
  }
}

// ─── Templates (table layout + inline styles: the only thing every mail client agrees on) ─────────
const esc = (s: string | null | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(shop: ShopSettings['shop'], heading: string, body: string): string {
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(heading)}</title></head>
<body style="margin:0;background:#f7f6f2;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#11141a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f2;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e3dc;">
<tr><td style="background:#11141a;padding:22px 28px;"><span style="font-size:22px;font-weight:800;letter-spacing:.5px;color:#ffffff;">OIL<span style="color:#f2a30b;">·</span>CENTER</span><br><span style="font-size:11px;letter-spacing:3px;color:#b3b9c3;">ΤΣΑΚΙΡΙΔΗΣ</span></td></tr>
<tr><td style="padding:28px;"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;">${esc(heading)}</h1>${body}</td></tr>
<tr><td style="background:#f5f6f8;padding:20px 28px;font-size:13px;line-height:1.6;color:#59616f;">
<strong style="color:#11141a;">${esc(shop.name)} — ${esc(shop.legalName)}</strong><br>${esc(fullAddress(shop))}<br>
Τηλ. <a href="tel:+30${shop.phone.replace(/\D/g, '')}" style="color:#11141a;">${esc(shop.phone)}</a>${shop.mobile ? ` · <a href="tel:+30${shop.mobile.replace(/\D/g, '')}" style="color:#11141a;">${esc(shop.mobile)}</a>` : ''}${shop.email ? ` · <a href="mailto:${esc(shop.email)}" style="color:#11141a;">${esc(shop.email)}</a>` : ''}
</td></tr></table></td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0 0;"><a href="${esc(href)}" style="display:inline-block;background:#f2a30b;color:#0a0c0f;font-weight:700;text-decoration:none;padding:13px 22px;border-radius:10px;">${esc(label)}</a></p>`;

function itemsTable(order: OrderWithItems): string {
  const row = (label: string, value: string, bold = false) =>
    `<tr><td style="padding:6px 0;color:#59616f;${bold ? 'font-weight:700;color:#11141a;font-size:16px;' : ''}">${label}</td><td align="right" style="padding:6px 0;${bold ? 'font-weight:700;font-size:16px;' : ''}">${value}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6e3dc;margin-top:20px;font-size:14px;">
${order.items.map((i) => `<tr><td style="padding:12px 0;border-bottom:1px solid #e6e3dc;"><strong>${esc(i.name)}</strong><br><span style="color:#59616f;">${esc(i.variantLabel)} · ${i.quantity} × ${formatPrice(i.unitPriceCents)}</span>${i.availability && i.availability !== 'in_stock' ? `<br><span style="color:#b45309;font-size:13px;">${esc(AVAILABILITY_LABELS[i.availability])}</span>` : ''}</td><td align="right" valign="top" style="padding:12px 0;border-bottom:1px solid #e6e3dc;white-space:nowrap;">${formatPrice(i.lineTotalCents)}</td></tr>`).join('')}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:14px;">
${row('Υποσύνολο', formatPrice(order.subtotalCents))}
${order.discountCents ? row(`Έκπτωση${order.couponCode ? ` (${esc(order.couponCode)})` : ''}`, `−${formatPrice(order.discountCents)}`) : ''}
${row('Μεταφορικά', order.shippingMethod === 'pickup' ? 'Παραλαβή από το κατάστημα' : order.shippingCents ? formatPrice(order.shippingCents) : 'Δωρεάν')}
${order.codFeeCents ? row('Αντικαταβολή', formatPrice(order.codFeeCents)) : ''}
${row('Σύνολο (με ΦΠΑ)', formatPrice(order.totalCents), true)}
</table>`;
}

function detailsBlock(order: OrderWithItems): string {
  const address = order.shippingMethod === 'courier' ? `${esc(order.street)}<br>${esc(order.postalCode)} ${esc(order.city)}${order.region ? `, ${esc(order.region)}` : ''}` : 'Παραλαβή από το κατάστημα';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;font-size:14px;line-height:1.6;"><tr>
<td valign="top" width="50%" style="padding-right:12px;"><strong>Παραλήπτης</strong><br>${esc(order.firstName)} ${esc(order.lastName)}<br>${address}<br>${esc(order.phone)}</td>
<td valign="top" width="50%"><strong>Αποστολή</strong><br>${SHIPPING_LABELS[order.shippingMethod]}<br><br><strong>Πληρωμή</strong><br>${PAYMENT_LABELS[order.paymentMethod]}${order.docType === 'invoice' ? `<br><br><strong>Τιμολόγιο</strong><br>${esc(order.companyName)} · ΑΦΜ ${esc(order.vatNumber)} · ΔΟΥ ${esc(order.taxOffice)}` : ''}</td>
</tr></table>${order.notes ? `<p style="margin:16px 0 0;font-size:14px;"><strong>Σχόλια:</strong> ${esc(order.notes)}</p>` : ''}`;
}

const orderUrl = (order: OrderWithItems) => `${siteUrl()}/order/${order.number}?t=${order.accessToken}`;

export function orderConfirmationMail(order: OrderWithItems, settings: ShopSettings): Mail {
  const { shop, payments } = settings;
  let next = '';
  if (order.paymentMethod === 'bank_transfer') {
    const accounts = payments.bankAccounts.map((a) => `<li style="margin-bottom:6px;"><strong>${esc(a.bank)}</strong><br>IBAN: ${esc(a.iban)}<br>Δικαιούχος: ${esc(a.holder)}</li>`).join('');
    next = `<div style="margin-top:20px;padding:16px;background:#fff8e6;border-radius:12px;font-size:14px;line-height:1.6;"><strong>Πληρωμή με τραπεζική κατάθεση</strong><br>Καταθέστε ${formatPrice(order.totalCents)} με αιτιολογία <strong>${esc(order.number)}</strong>. Η παραγγελία αποστέλλεται μόλις επιβεβαιωθεί η κατάθεση.${accounts ? `<ul style="padding-left:18px;margin:10px 0 0;">${accounts}</ul>` : '<br>Θα επικοινωνήσουμε μαζί σας με τα στοιχεία του λογαριασμού.'}</div>`;
  } else if (order.shippingMethod === 'pickup') {
    next = `<div style="margin-top:20px;padding:16px;background:#fff8e6;border-radius:12px;font-size:14px;line-height:1.6;"><strong>Παραλαβή από το κατάστημα</strong><br>Θα σας ειδοποιήσουμε μόλις η παραγγελία είναι έτοιμη. ${esc(fullAddress(shop))} — <a href="${esc(mapsDirectionsUrl(shop))}" style="color:#15406b;">οδηγίες στο Google Maps</a>.</div>`;
  }
  const body = `<p style="margin:0;font-size:15px;line-height:1.6;">Γεια σας ${esc(order.firstName)}, λάβαμε την παραγγελία σας <strong>${esc(order.number)}</strong> (${formatDateTime(order.createdAt)}). Θα επικοινωνήσουμε μαζί σας αν χρειαστεί κάποια διευκρίνιση.</p>${order.isTest ? '<p style="margin:14px 0 0;padding:10px 14px;background:#eef5fc;border-radius:10px;font-size:13px;color:#15406b;">Δοκιμαστική παραγγελία: το κατάστημα λειτουργεί σε δοκιμαστική λειτουργία και η παραγγελία δεν θα εκτελεστεί.</p>' : ''}${next}${itemsTable(order)}${detailsBlock(order)}${button(orderUrl(order), 'Παρακολούθηση παραγγελίας')}`;
  return { to: order.email, subject: `Η παραγγελία σας ${order.number} — Oil Center`, html: layout(shop, 'Ευχαριστούμε για την παραγγελία σας!', body), replyTo: shop.email || undefined };
}

export function newOrderNotificationMail(order: OrderWithItems, settings: ShopSettings): Mail {
  const body = `<p style="margin:0;font-size:15px;line-height:1.6;"><strong>${esc(order.firstName)} ${esc(order.lastName)}</strong> · <a href="tel:${esc(order.phone)}" style="color:#11141a;">${esc(order.phone)}</a> · <a href="mailto:${esc(order.email)}" style="color:#11141a;">${esc(order.email)}</a><br>Σύνολο <strong>${formatPrice(order.totalCents)}</strong> · ${PAYMENT_LABELS[order.paymentMethod]} · ${SHIPPING_LABELS[order.shippingMethod]}${order.isTest ? ' · <strong>ΔΟΚΙΜΑΣΤΙΚΗ</strong>' : ''}</p>${itemsTable(order)}${detailsBlock(order)}${button(`${siteUrl()}/admin/orders/${order.id}`, 'Άνοιγμα στη διαχείριση')}`;
  return { to: process.env.ORDERS_NOTIFY_EMAIL || settings.shop.email, subject: `Νέα παραγγελία ${order.number} · ${formatPrice(order.totalCents)}`, html: layout(settings.shop, `Νέα παραγγελία ${order.number}`, body), replyTo: order.email };
}

export function orderStatusMail(order: OrderWithItems, settings: ShopSettings): Mail {
  const { shop } = settings;
  const messages: Partial<Record<OrderWithItems['status'], string>> = {
    confirmed: 'Η παραγγελία σας επιβεβαιώθηκε και ετοιμάζεται.',
    processing: 'Η παραγγελία σας ετοιμάζεται.',
    shipped: `Η παραγγελία σας παραδόθηκε στην εταιρεία ταχυμεταφορών${order.trackingCarrier ? ` (${esc(order.trackingCarrier)})` : ''}.${order.trackingNumber ? ` Αριθμός αποστολής: <strong>${esc(order.trackingNumber)}</strong>.` : ''}`,
    ready_for_pickup: `Η παραγγελία σας είναι έτοιμη για παραλαβή από το κατάστημα: ${esc(fullAddress(shop))} — <a href="${esc(mapsDirectionsUrl(shop))}" style="color:#15406b;">οδηγίες</a>.`,
    completed: 'Η παραγγελία σας ολοκληρώθηκε. Σας ευχαριστούμε για την προτίμηση!',
    cancelled: 'Η παραγγελία σας ακυρώθηκε. Αν έχετε ήδη πληρώσει, θα επικοινωνήσουμε μαζί σας για την επιστροφή των χρημάτων.',
  };
  const body = `<p style="margin:0;font-size:15px;line-height:1.6;">Γεια σας ${esc(order.firstName)}, ${messages[order.status] ?? `η κατάσταση της παραγγελίας σας άλλαξε σε «${ORDER_STATUS_LABELS[order.status]}».`}</p>${itemsTable(order)}${button(orderUrl(order), 'Προβολή παραγγελίας')}`;
  return { to: order.email, subject: `Παραγγελία ${order.number}: ${ORDER_STATUS_LABELS[order.status]}`, html: layout(shop, ORDER_STATUS_LABELS[order.status], body), replyTo: shop.email || undefined };
}

/** `heading` and `details` come from the forms that ask structured questions (vehicle enquiry, quote request); the e-mail is optional there. */
export function contactMail(input: { name: string; email: string; phone?: string | null; subject?: string | null; message: string; heading?: string; details?: Array<[string, string]> | null }, settings: ShopSettings): Mail {
  const contact = [input.email && `<a href="mailto:${esc(input.email)}" style="color:#11141a;">${esc(input.email)}</a>`, input.phone && `<a href="tel:${esc(input.phone)}" style="color:#11141a;">${esc(input.phone)}</a>`].filter(Boolean).join(' · ');
  const details = input.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 0;font-size:15px;line-height:1.5;">${input.details.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#5b6472;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;font-weight:600;">${esc(v)}</td></tr>`).join('')}</table>`
    : '';
  const message = input.message ? `<p style="margin:16px 0 0;padding:16px;background:#f5f6f8;border-radius:12px;font-size:15px;line-height:1.6;white-space:pre-wrap;">${esc(input.message)}</p>` : '';
  const body = `<p style="margin:0;font-size:15px;line-height:1.6;"><strong>${esc(input.name)}</strong>${contact ? ` · ${contact}` : ''}</p>${details}${message}`;
  return { to: process.env.ORDERS_NOTIFY_EMAIL || settings.shop.email, subject: `${input.heading ?? 'Μήνυμα από το site'}: ${input.subject || input.name}`, html: layout(settings.shop, input.heading ?? 'Νέο μήνυμα επικοινωνίας', body), replyTo: input.email || undefined };
}

export function passwordResetMail(to: string, token: string, settings: ShopSettings): Mail {
  const url = `${siteUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const body = `<p style="margin:0;font-size:15px;line-height:1.6;">Λάβαμε αίτημα επαναφοράς του κωδικού σας. Ο σύνδεσμος ισχύει για 1 ώρα. Αν δεν το ζητήσατε εσείς, αγνοήστε αυτό το μήνυμα.</p>${button(url, 'Ορισμός νέου κωδικού')}`;
  return { to, subject: 'Επαναφορά κωδικού — Oil Center', html: layout(settings.shop, 'Επαναφορά κωδικού', body) };
}
