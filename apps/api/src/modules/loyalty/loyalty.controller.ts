import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { LoyaltyService } from './loyalty.service';
import { AdjustPointsDto, RedeemPointsDto } from './dto/loyalty.dto';

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
