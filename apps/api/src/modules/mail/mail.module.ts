import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Owns the email transport. Kept as its own module so the Email Infrastructure
 * milestone can wire a provider (Resend) in one place, and any feature that
 * needs to send mail imports this rather than reaching for a provider SDK.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
