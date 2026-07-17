import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { TenantContext } from '../../common/context/tenant-context';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { RestaurantsService } from './restaurants.service';

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurants: RestaurantsService) {}

  /**
   * Authenticated but deliberately NOT permission-guarded.
   *
   * Every permission is scoped to a restaurant, and this is the call that
   * creates the first one — requiring a permission here would be a deadlock:
   * you would need a membership to create the thing that grants membership.
   * The authorization rule is simply "a logged-in user may create a
   * restaurant, and becomes its owner".
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  async create(
    @CurrentUser() ctx: TenantContext,
    @Body() dto: CreateRestaurantDto,
  ) {
    return this.restaurants.create(ctx.userId, dto);
  }

  @Get()
  async list(@CurrentUser() ctx: TenantContext) {
    return this.restaurants.listForUser(ctx.userId);
  }
}
