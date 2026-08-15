import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { CombosController } from './combos.controller';
import { CombosService } from './combos.service';

@Module({
  controllers: [CatalogueController, CombosController],
  providers: [CatalogueService, CombosService],
})
export class CatalogueModule {}
