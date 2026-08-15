import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CombosService } from './combos.service';
import {
  CreateComboDto,
  CreateUpsellRuleDto,
  ListCombosQuery,
  UpdateComboDto,
  UpdateUpsellRuleDto,
} from './dto/combo.dto';

/**
 * Combos and upsell rules. Cashiers and kitchen may READ (to sell / prepare);
 * only product.manage may configure. Backend authorization — never hidden UI.
 */
@Controller()
export class CombosController {
  constructor(private readonly combos: CombosService) {}

  @RequirePermissions('product.read')
  @Get('combos')
  listCombos(@Query() query: ListCombosQuery) {
    return this.combos.listCombos(query.include === 'all');
  }

  @RequirePermissions('product.manage')
  @Post('combos')
  createCombo(@Body() dto: CreateComboDto) {
    return this.combos.createCombo(dto);
  }

  @RequirePermissions('product.manage')
  @Patch('combos/:id')
  updateCombo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateComboDto,
  ) {
    return this.combos.updateCombo(id, dto);
  }

  @RequirePermissions('product.manage')
  @Delete('combos/:id')
  deleteCombo(@Param('id', ParseUUIDPipe) id: string) {
    return this.combos.deleteCombo(id);
  }

  @RequirePermissions('product.read')
  @Get('upsell-rules')
  listUpsellRules() {
    return this.combos.listUpsellRules();
  }

  @RequirePermissions('product.manage')
  @Post('upsell-rules')
  createUpsellRule(@Body() dto: CreateUpsellRuleDto) {
    return this.combos.createUpsellRule(dto);
  }

  @RequirePermissions('product.manage')
  @Patch('upsell-rules/:id')
  updateUpsellRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUpsellRuleDto,
  ) {
    return this.combos.updateUpsellRule(id, dto);
  }

  @RequirePermissions('product.manage')
  @Delete('upsell-rules/:id')
  deleteUpsellRule(@Param('id', ParseUUIDPipe) id: string) {
    return this.combos.deleteUpsellRule(id);
  }
}
