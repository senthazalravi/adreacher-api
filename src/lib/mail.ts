// Transactional email via the Resend HTTP API (https://api.resend.com/emails).
// Workers have no SMTP, so all outbound mail goes through this helper.
// When RESEND_API_KEY is unset (local dev), the email is logged instead of
// sent so auth flows stay testable without credentials.
// NOTE: for production, verify the sending domain in the Resend dashboard
// (Domains -> Add Domain); until then Resend only delivers to the account
// owner's address.

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendMail(
  env: { RESEND_API_KEY?: string; EMAIL_FROM?: string },
  msg: MailMessage,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM ?? "AdReacher <noreply@adreacher.app>";
  if (!apiKey) {
    console.log(`[mail:dev] to=${msg.to} subject=${msg.subject}\n${msg.text ?? msg.html}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${text.slice(0, 200)}`);
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
