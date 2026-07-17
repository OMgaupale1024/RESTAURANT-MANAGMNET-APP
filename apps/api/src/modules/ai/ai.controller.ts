import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/auth.decorators';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /**
   * The daily briefing. Read-only, owner/manager only, tenant-scoped by RLS.
   * Every insight carries its method and its basis — see AiService.
   */
  @RequirePermissions('ai.read')
  @Get('insights')
  insights() {
    return this.ai.insights();
  }
}
