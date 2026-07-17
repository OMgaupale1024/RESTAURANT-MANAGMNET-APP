import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CreateCouponDto, UpdateCouponDto } from './dto/coupon.dto';
import { MarketingService } from './marketing.service';

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @RequirePermissions('marketing.read')
  @Get('coupons')
  listCoupons() {
    return this.marketing.listCoupons();
  }

  @RequirePermissions('marketing.manage')
  @Post('coupons')
  createCoupon(@Body() dto: CreateCouponDto) {
    return this.marketing.createCoupon(dto);
  }

  @RequirePermissions('marketing.manage')
  @Patch('coupons/:id')
  setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCouponDto,
  ) {
    return this.marketing.setCouponActive(id, dto);
  }

  @RequirePermissions('marketing.read')
  @Get('segments')
  segments() {
    return this.marketing.segments();
  }

  @RequirePermissions('marketing.read')
  @Get('segments/:key/customers')
  segmentCustomers(@Param('key') key: string) {
    return this.marketing.segmentCustomers(key);
  }
}
