/**
 * Email content, kept separate from delivery. Each builder returns a subject
 * plus both an HTML and a plain-text body — never one without the other, so a
 * text-only client is never left with a blank message.
 *
 * Templates receive already-built URLs and names; they never see a raw token or
 * any provider detail.
 */

type Built = { subject: string; html: string; text: string };

// Restaurant names are user-controlled and land in HTML — escape them so a name
// like `<script>` cannot inject into the recipient's email. URLs are built
// server-side from a known base and go in href, which needs no escaping here.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A restrained, client-safe shell: inline styles only (email clients strip
// <style>), a max width, system fonts. Enough to look intentional, not a
// framework.
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f5f5f5;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5;">
      <tr><td style="padding:28px 32px 8px;font-size:18px;font-weight:600;">OraOS</td></tr>
      <tr><td style="padding:8px 32px 32px;font-size:15px;line-height:1.6;color:#333;">${bodyHtml}</td></tr>
    </table>
    <p style="max-width:480px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#888;text-align:center;">
      OraOS — the operating system for restaurants.
    </p>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px;">${label}</a>`;
}

export function passwordResetEmail(resetUrl: string): Built {
  const subject = 'Reset your OraOS password';
  const text =
    'Someone asked to reset the password for this OraOS account.\n\n' +
    `Reset it here (the link expires in 30 minutes):\n${resetUrl}\n\n` +
    "If this wasn't you, you can ignore this email — your password is unchanged " +
    'and nobody can see it.\n\n' +
    'Need help? Reply to this email and our team will get back to you.';
  const html = shell(
    `<p>Someone asked to reset the password for this OraOS account.</p>
     <p style="margin:24px 0;">${button(resetUrl, 'Reset password')}</p>
     <p style="color:#666;font-size:13px;">This link expires in <strong>30 minutes</strong>.</p>
     <p style="color:#666;font-size:13px;">If this wasn't you, ignore this email — your password is unchanged and nobody can see it.</p>
     <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
     <p style="color:#888;font-size:12px;">Need help? Just reply to this email.</p>`,
  );
  return { subject, html, text };
}

export type StaffInviteParams = {
  restaurantName: string;
  roleName: string;
  acceptUrl: string;
  expiresAt: Date;
};

export function staffInviteEmail(p: StaffInviteParams): Built {
  const expires = p.expiresAt.toUTCString();
  const subject = `You're invited to join ${p.restaurantName} on OraOS`;
  const text =
    `You've been invited to join ${p.restaurantName} on OraOS as ${p.roleName}.\n\n` +
    `Accept the invitation and set your password here (expires ${expires}):\n${p.acceptUrl}\n\n` +
    "If you weren't expecting this, you can ignore this email.\n\n" +
    'Need help? Reply to this email and our team will get back to you.';
  const html = shell(
    `<p>You've been invited to join <strong>${esc(p.restaurantName)}</strong> on OraOS as <strong>${esc(p.roleName)}</strong>.</p>
     <p style="margin:24px 0;">${button(p.acceptUrl, 'Accept invitation')}</p>
     <p style="color:#666;font-size:13px;">This invitation expires on <strong>${expires}</strong>.</p>
     <p style="color:#666;font-size:13px;">If you weren't expecting this, you can ignore this email.</p>
     <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
     <p style="color:#888;font-size:12px;">Need help? Just reply to this email.</p>`,
  );
  return { subject, html, text };
}
