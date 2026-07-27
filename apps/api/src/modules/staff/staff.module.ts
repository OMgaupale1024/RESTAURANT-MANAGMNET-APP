import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { EventsModule } from '../../events/events.module';
import { JoinController, StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  // TokenService issues the pair when an invite is accepted; MailModule sends
  // the invitation email; EventsModule provides the tenant event writer.
  imports: [AuthModule, MailModule, EventsModule],
  controllers: [StaffController, JoinController],
  providers: [StaffService],
})
export class StaffModule {}
