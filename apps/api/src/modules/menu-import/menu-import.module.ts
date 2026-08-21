import { Module } from '@nestjs/common';
import { EventsModule } from '../../events/events.module';
import { MenuExtractionService } from './menu-extraction.service';
import { MenuImportController } from './menu-import.controller';
import { MenuImportService } from './menu-import.service';

@Module({
  // EventsModule for the append-only audit row every import writes.
  imports: [EventsModule],
  controllers: [MenuImportController],
  providers: [MenuImportService, MenuExtractionService],
})
export class MenuImportModule {}
