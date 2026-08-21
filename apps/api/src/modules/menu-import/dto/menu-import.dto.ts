import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsObject,
  IsString,
} from 'class-validator';

/**
 * Base64 data-URL images. The array bounds live here; per-image type and byte
 * checks happen in the service (validateImages), which also knows the size cap.
 */
export class ExtractMenuDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  images!: string[];
}

/**
 * A menu draft, or the final import payload — both are `{ result: <menu> }`.
 * `result` is validated in DEPTH by zod (ReviewMenuSchema) in the service;
 * class-validator only asserts it is an object here, deliberately, because the
 * global whitelist pipe must not strip its nested fields.
 */
export class MenuResultDto {
  @IsDefined()
  @IsObject()
  result!: Record<string, unknown>;
}
