import { Module } from '@nestjs/common';
import { EventsService } from './events.service';

/**
 * Exposes EventsService — the single seam every feature uses to record tenant
 * events. EventsService injects nothing (it takes the caller's transaction
 * client and reads the request context directly), so this module has no
 * imports and adds no coupling: any feature module can import it without
 * pulling in a dependency graph, and there is no path to a circular import.
 */
@Module({
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
