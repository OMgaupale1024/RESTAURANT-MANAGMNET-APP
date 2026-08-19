import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { LoyaltyService } from './loyalty.service';
import {
  AdjustPointsDto,
  RedeemPointsDto,
  UpdateLoyaltySettingsDto,
} from './dto/loyalty.dto';

/**
 * The admin-safe loyalty surface. Reading a balance needs loyalty.read;
 * redeeming needs loyalty.redeem (the cashier does it at the till); awarding,
 * correcting or reversing points needs loyalty.adjust (a manager action, and a
 * money-adjacent one). Tenant and actor come from the token, never the client;
 * RLS scopes every row underneath.
 *
 * earn/reverse are exposed as explicit endpoints so the foundation is complete
 * and testable on its own. Wiring them into checkout and refunds is a later
 * milestone (Smart Checkout), which will call these same service methods.
 */
@Controller()
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  // Loyalty configuration: reuses loyalty.adjust — the manager-level,
  // money-adjacent loyalty permission (OWNER + MANAGER, never CASHIER/KITCHEN),
  // which is exactly who may set the program's rules.
  @RequirePermissions('loyalty.adjust')
  @Get('loyalty/settings')
  getSettings() {
    return this.loyalty.getSettings();
  }

  @RequirePermissions('loyalty.adjust')
  @Put('loyalty/settings')
  updateSettings(@Body() dto: UpdateLoyaltySettingsDto) {
    return this.loyalty.updateSettings(dto);
  }

  @RequirePermissions('loyalty.read')
  @Get('customers/:customerId/loyalty')
  summary(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.loyalty.getSummary(customerId);
  }

  @RequirePermissions('loyalty.redeem')
  @Post('customers/:customerId/loyalty/redeem')
  redeem(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: RedeemPointsDto,
  ) {
    return this.loyalty.redeem(customerId, dto);
  }

  @RequirePermissions('loyalty.adjust')
  @Post('customers/:customerId/loyalty/adjust')
  adjust(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AdjustPointsDto,
  ) {
    return this.loyalty.adjust(customerId, dto);
  }

  @RequirePermissions('loyalty.adjust')
  @Post('orders/:orderId/loyalty/earn')
  earn(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.loyalty.earnForOrder(orderId);
  }

  @RequirePermissions('loyalty.adjust')
  @Post('orders/:orderId/loyalty/reverse')
  reverse(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.loyalty.reverseForOrder(orderId);
  }
}
