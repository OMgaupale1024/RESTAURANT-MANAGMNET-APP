import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/**
 * The one seam between the app and whatever actually sends email.
 *
 * Domain methods (sendPasswordResetEmail, …) compose a MailMessage and hand it
 * to send(). send() is the transport — the ONLY place a provider lives. The
 * Email Infrastructure milestone swaps its body for Resend and nothing else
 * changes: no caller and no domain method knows the provider exists.
 *
 * Until then send() is a dev transport: it logs the message instead of
 * delivering it, so local flows and tests are deterministic and side-effect
 * free. In production, once a real transport replaces this body, it must NOT
 * log message bodies (they carry reset links).
 */
@Injectable()
export class MailService {
  constructor(private readonly logger: PinoLogger) {}

  send(message: MailMessage): Promise<void> {
    // Dev transport — no provider configured yet. The full text is logged on
    // purpose so a developer can follow a reset link locally. Returns a promise
    // (not `async`) so the real transport can simply await a provider call here.
    this.logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      'Email (dev transport — logged, not sent)',
    );
    return Promise.resolve();
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.send({
      to,
      subject: 'Reset your OraOS password',
      text:
        'Someone asked to reset the password for this OraOS account.\n\n' +
        `Reset it here (the link expires in 30 minutes):\n${resetUrl}\n\n` +
        "If this wasn't you, you can ignore this email — your password is unchanged.",
    });
  }
}
