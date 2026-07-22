import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import {
  emailVerificationEmail,
  passwordResetEmail,
  staffInviteEmail,
  type StaffInviteParams,
} from './mail-templates';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Raised when delivery fails for good (permanent rejection or retries spent). */
export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
// A slow provider must not hold an HTTP handler open; each attempt is bounded.
const SEND_TIMEOUT_MS = 10_000;
// One try plus two retries. Only transient failures (5xx, 429, network) retry.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The one seam between the app and whatever sends email.
 *
 * Domain methods (sendPasswordResetEmail, sendStaffInviteEmail, …) compose a
 * MailMessage and hand it to send(). send() is the transport — the ONLY place a
 * provider (Resend) exists. Adding a new kind of email is a new domain method;
 * no caller and no other module ever touches provider code.
 *
 * With no provider configured (local, tests, or a not-yet-configured deploy) it
 * falls back to a log transport, so nothing needs a real key to run.
 *
 * Logging is deliberately narrow: to + subject + status only. Message bodies
 * (which carry reset and invite links) and the API key are never logged.
 */
@Injectable()
export class MailService {
  private readonly apiKey?: string;
  private readonly from?: string;
  private readonly isProd: boolean;

  constructor(
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.apiKey = config.get<string>('RESEND_API_KEY') || undefined;
    this.from = config.get<string>('MAIL_FROM') || undefined;
    this.isProd = config.get<string>('NODE_ENV') === 'production';
    if (!this.apiKey) {
      this.logger.warn(
        'No mail provider configured (RESEND_API_KEY unset) — email is logged, not sent.',
      );
    }
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.send({ to, ...passwordResetEmail(resetUrl) });
  }

  async sendEmailVerificationEmail(
    to: string,
    verifyUrl: string,
  ): Promise<void> {
    await this.send({ to, ...emailVerificationEmail(verifyUrl) });
  }

  async sendStaffInviteEmail(
    to: string,
    params: StaffInviteParams,
  ): Promise<void> {
    await this.send({ to, ...staffInviteEmail(params) });
  }

  async send(message: MailMessage): Promise<void> {
    if (this.apiKey && this.from) {
      await this.deliverViaResend(message);
      return;
    }
    this.logOnly(message);
  }

  /**
   * Posts to Resend with a per-attempt timeout and bounded retries.
   *
   * Retries only what can succeed on a second try: network errors, timeouts,
   * 429, and 5xx. A 4xx (bad payload, bad key) is permanent and fails fast —
   * retrying it just wastes time and hammers the provider.
   */
  private async deliverViaResend(message: MailMessage): Promise<void> {
    const meta = { to: message.to, subject: message.subject };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: this.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        if (res.ok) {
          const id = await res
            .json()
            .then((b: { id?: string }) => b?.id)
            .catch(() => undefined);
          this.logger.info({ ...meta, providerId: id, attempt }, 'Email sent');
          return;
        }

        // Permanent: the provider will reject this payload every time.
        if (res.status < 500 && res.status !== 429) {
          this.logger.error(
            { ...meta, status: res.status },
            'Email rejected by provider (permanent)',
          );
          throw new MailDeliveryError(
            `Resend rejected the message (${res.status})`,
          );
        }

        // Transient: fall through to a retry.
        this.logger.warn(
          { ...meta, status: res.status, attempt },
          'Email send failed (transient)',
        );
      } catch (err) {
        if (err instanceof MailDeliveryError) throw err;
        // Network error, timeout, or abort. Log the error's NAME only — never
        // the object, which could echo request detail.
        this.logger.warn(
          {
            ...meta,
            attempt,
            error: err instanceof Error ? err.name : 'unknown',
          },
          'Email send errored (transient)',
        );
      }

      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
    }

    this.logger.error(meta, 'Email delivery failed after retries');
    throw new MailDeliveryError('Email delivery failed after retries');
  }

  private logOnly(message: MailMessage): void {
    const meta = { to: message.to, subject: message.subject };
    if (this.isProd) {
      // Never silently succeed in production, and never log the body.
      this.logger.warn(meta, 'Email not sent: no mail provider configured');
      return;
    }
    // Dev only: include the body so a developer can follow the link locally.
    this.logger.info(
      { ...meta, text: message.text },
      'Email (dev transport — logged, not sent)',
    );
  }
}
