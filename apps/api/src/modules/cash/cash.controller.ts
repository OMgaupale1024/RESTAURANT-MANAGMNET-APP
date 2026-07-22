import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { CashService } from './cash.service';
import {
  CashMovementDto,
  CloseSessionDto,
  OpenSessionDto,
} from './dto/cash.dto';

@Controller('cash')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @RequirePermissions('cash.read')
  @Get('sessions/current')
  current() {
    return this.cash.current();
  }

  @RequirePermissions('cash.read')
  @Get('sessions')
  list() {
    return this.cash.list();
  }

  @RequirePermissions('cash.read')
  @Get('sessions/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.cash.getById(id);
  }

  @RequirePermissions('cash.manage')
  @Post('sessions')
  open(@Body() dto: OpenSessionDto) {
    return this.cash.open(dto);
  }

  @RequirePermissions('cash.manage')
  @Post('sessions/:id/movements')
  recordMovement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CashMovementDto,
  ) {
    return this.cash.recordMovement(id, dto);
  }

  @RequirePermissions('cash.manage')
  @Post('sessions/:id/close')
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseSessionDto) {
    return this.cash.close(id, dto);
  }
}
