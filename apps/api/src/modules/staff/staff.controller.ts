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
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  Public,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import {
  AcceptInviteDto,
  ClockDto,
  CreateInviteDto,
  TimesheetQuery,
  UpdateMemberDto,
} from './dto/staff.dto';
import { StaffService } from './staff.service';

@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @RequirePermissions('member.read')
  @Get()
  list() {
    return this.staff.list();
  }

  @RequirePermissions('member.manage')
  @Get('invites')
  listInvites() {
    return this.staff.listInvites();
  }

  @RequirePermissions('member.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invites')
  createInvite(@Body() dto: CreateInviteDto) {
    return this.staff.createInvite(dto);
  }

  @RequirePermissions('member.manage')
  @Delete('invites/:id')
  revokeInvite(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeInvite(id);
  }

  @RequirePermissions('member.manage')
  @Patch(':id')
  updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.staff.updateMember(id, dto);
  }

  /** Clock yourself in or out. */
  @RequirePermissions('attendance.record')
  @Post('me/clock')
  clockSelf(@Body() dto: ClockDto) {
    return this.staff.clock(null, dto);
  }

  /** Clock someone else in or out. Requires attendance.manage (checked in the service). */
  @RequirePermissions('attendance.record')
  @Post(':id/clock')
  clockOther(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClockDto) {
    return this.staff.clock(id, dto);
  }

  @RequirePermissions('attendance.manage')
  @Get('timesheet')
  timesheet(@Query() query: TimesheetQuery) {
    return this.staff.timesheet(query);
  }
}

/**
 * Invite acceptance is PUBLIC by necessity: the invitee has no account yet, so
 * there is no token to authenticate with. The invite token IS the credential,
 * which is why it is 256 bits of CSPRNG entropy, stored hashed, single-use, and
 * expiring.
 */
@Controller('join')
export class JoinController {
  constructor(private readonly staff: StaffService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get(':token')
  describe(@Param('token') token: string) {
    return this.staff.describeInvite(token);
  }

  @Public()
  // Tight: this endpoint creates accounts.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token')
  accept(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
  ) {
    return this.staff.acceptInvite(token, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
