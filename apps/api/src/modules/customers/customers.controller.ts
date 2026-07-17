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
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  FindCustomersQuery,
  UpdateCustomerDto,
} from './dto/customer.dto';

/**
 * Customer records are PII. Every route requires an explicit permission, and
 * KITCHEN deliberately holds neither — a kitchen screen has no business
 * reading a customer's phone number and birthday.
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermissions('customer.read')
  @Get()
  list(@Query() query: FindCustomersQuery) {
    return this.customers.list(query);
  }

  /** Exact phone lookup for the till. Placed before :id so it is not shadowed. */
  @RequirePermissions('customer.read')
  @Get('by-phone/:phone')
  findByPhone(@Param('phone') phone: string) {
    return this.customers.findByPhone(phone);
  }

  @RequirePermissions('customer.read')
  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.getById(id);
  }

  @RequirePermissions('customer.manage')
  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @RequirePermissions('customer.manage')
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(id, dto);
  }
}
