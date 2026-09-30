// Transactional email via the ElasticEmail HTTP API (Workers have no SMTP).
//
// TODO: verify the exact v2 endpoint shape against ElasticEmail's docs before
// first production send. Known-good shape per their API reference:
//   POST https://api.elasticemail.com/v2/email/send
//   Content-Type: application/x-www-form-urlencoded
//   apikey, from, fromName, to, subject, bodyHtml, bodyText, isTransactional
// When ELASTICEMAIL_API_KEY is unset (local dev), the email is logged instead
// of sent so auth flows stay testable without credentials.

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendMail(
  env: { ELASTICEMAIL_API_KEY?: string; ELASTICEMAIL_FROM?: string },
  msg: MailMessage,
): Promise<void> {
  const apiKey = env.ELASTICEMAIL_API_KEY;
  const from = env.ELASTICEMAIL_FROM ?? "noreply@adreacher.app";
  if (!apiKey) {
    console.log(`[mail:dev] to=${msg.to} subject=${msg.subject}\n${msg.text ?? msg.html}`);
    return;
  }
  const body = new URLSearchParams({
    apikey: apiKey,
    from,
    fromName: "AdReacher",
    to: msg.to,
    subject: msg.subject,
    bodyHtml: msg.html,
    isTransactional: "true",
  });
  if (msg.text) body.set("bodyText", msg.text);
  const res = await fetch("https://api.elasticemail.com/v2/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElasticEmail send failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

export function linkEmail(opts: {
  appUrl: string;
  heading: string;
  body: string;
  ctaUrl: string;
  ctaLabel: string;
}): { subject: string; html: string; text: string } {
  const { heading, body, ctaUrl, ctaLabel } = opts;
  return {
    subject: `AdReacher — ${heading}`,
    html: `<div style="font-family:sans-serif;max-width:560px"><h2>${heading}</h2><p>${body}</p><p><a href="${ctaUrl}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${ctaLabel}</a></p><p style="color:#888;font-size:12px">If the button doesn't work, copy this link: ${ctaUrl}</p></div>`,
    text: `${heading}\n\n${body}\n\n${ctaLabel}: ${ctaUrl}`,
  };
}
