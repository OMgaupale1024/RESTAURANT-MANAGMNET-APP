import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQuery } from './dto/list-orders.query';
import { UpdateStatusDto } from './dto/update-status.dto';
import { OrdersService } from './orders.service';
import { VOID_STATUSES } from './order-status';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermissions('order.create')
  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.orders.create(dto);
  }

  @RequirePermissions('order.read')
  @Get()
  list(@Query() query: ListOrdersQuery) {
    return this.orders.list({ status: query.status, limit: query.limit });
  }

  @RequirePermissions('order.read')
  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getById(id);
  }

  @RequirePermissions('order.read')
  @Get(':id/timeline')
  timeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.timeline(id);
  }

  /**
   * Status transitions.
   *
   * Permission is decided per TARGET status, not per endpoint. `order.update`
   * covers the kitchen flow (PREPARING/READY/COMPLETED/CANCELLED); moving to
   * VOIDED additionally requires `order.void`, which a cashier does not hold.
   * A single @RequirePermissions on the route could not express that, so the
   * void check lives in the handler.
   */
  @RequirePermissions('order.update')
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.orders.updateStatus(id, dto.status, dto.reason, {
      requireVoidPermission: VOID_STATUSES.includes(dto.status),
    });
  }
}
