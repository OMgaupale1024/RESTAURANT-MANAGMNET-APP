import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

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
  list() {
    return this.orders.list();
  }

  @RequirePermissions('order.read')
  @Get(':id')
  // ParseUUIDPipe rejects a malformed id before it reaches the database.
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getById(id);
  }
}
