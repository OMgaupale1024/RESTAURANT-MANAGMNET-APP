import type { AccessTokenPayload } from '../modules/auth/token.service';

// The guard attaches verified claims here. Named tokenPayload rather than
// `user` to keep it obvious that this is decoded-token data, not a User record.
declare global {
  namespace Express {
    interface Request {
      tokenPayload?: AccessTokenPayload;
    }
  }
}

export {};
