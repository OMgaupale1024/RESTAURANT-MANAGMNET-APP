import { Module } from '@nestjs/common';
import { EventsModule } from '../../events/events.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [EventsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
