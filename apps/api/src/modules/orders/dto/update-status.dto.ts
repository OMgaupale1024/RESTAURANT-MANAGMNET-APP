import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStatus } from '../../../generated/prisma/enums';

export class UpdateStatusDto {
  // The enum is the first gate; the state machine is the second. Validation
  // alone would happily accept COMPLETED from any state.
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  /** Why. Recorded on the event, and required in practice for a void. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
