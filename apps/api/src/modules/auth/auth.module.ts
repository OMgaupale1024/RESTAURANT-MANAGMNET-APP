import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { SecurityEventService } from './security-event.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    MailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS'),
          issuer: 'oraos',
          audience: 'oraos-api',
        },
        verifyOptions: {
          // Verification must assert these, not merely sign them — otherwise a
          // token minted by another system with the same secret would pass.
          issuer: 'oraos',
          audience: 'oraos-api',
          algorithms: ['HS256'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, SecurityEventService],
  // JwtModule is re-exported because the global JwtAuthGuard is registered in
  // AppModule and needs JwtService resolvable there.
  exports: [TokenService, SecurityEventService, JwtModule],
})
export class AuthModule {}
