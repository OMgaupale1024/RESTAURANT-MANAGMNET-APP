import { redactUrl } from './redact-url';

describe('redactUrl', () => {
  it('masks the staff-invite token in the path', () => {
    expect(redactUrl('/api/v1/join/abc123SECRETtoken')).toBe(
      '/api/v1/join/[REDACTED]',
    );
  });

  it('keeps the rest of the path intact', () => {
    expect(redactUrl('/api/v1/join/tok?next=/dashboard')).toBe(
      '/api/v1/join/[REDACTED]?next=/dashboard',
    );
  });

  it('masks a token query parameter', () => {
    expect(redactUrl('/api/v1/auth/reset?token=SUPERSECRET&x=1')).toBe(
      '/api/v1/auth/reset?token=[REDACTED]&x=1',
    );
  });

  it('leaves an ordinary URL unchanged', () => {
    expect(redactUrl('/api/v1/orders?limit=20')).toBe(
      '/api/v1/orders?limit=20',
    );
  });
});
