import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { MailDeliveryError, MailService } from './mail.service';

/**
 * MailService in isolation: the Resend transport (auth, payload, retry,
 * timeouts, permanent-vs-transient), the dev fallback, and the security
 * invariant that neither the token nor the API key ever reaches a log.
 */

const API_KEY = 'resend_test_key_do_not_log';
const RESET_URL =
  'https://app.example.com/reset-password?token=SUPER-SECRET-TOKEN';

type Log = { level: string; args: unknown[] };

function build(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    RESEND_API_KEY: API_KEY,
    MAIL_FROM: 'OraOS <noreply@oraos.app>',
    NODE_ENV: 'test',
    ...overrides,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;

  const logs: Log[] = [];
  const push =
    (level: string) =>
    (...args: unknown[]) =>
      void logs.push({ level, args });
  const logger = {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  } as unknown as PinoLogger;

  return { svc: new MailService(config, logger), logs };
}

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

type Payload = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
};
const bodyOf = (init: RequestInit) =>
  JSON.parse(init.body as string) as Payload;

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

/** Everything that reached the logger, flattened to one searchable string. */
const logText = (logs: Log[]) => JSON.stringify(logs);

describe('MailService — Resend transport', () => {
  it('posts to Resend with bearer auth and both bodies, and returns the id', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(response(200, { id: 'msg_1' }));
    global.fetch = fetchMock;

    const { svc, logs } = build();
    await svc.sendPasswordResetEmail('user@example.com', RESET_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    const payload = bodyOf(init);
    expect(payload.to).toBe('user@example.com');
    expect(payload.from).toBe('OraOS <noreply@oraos.app>');
    expect(payload.html).toContain('Reset password');
    expect(payload.text).toContain(RESET_URL);
    expect(init.signal).toBeInstanceOf(AbortSignal); // per-attempt timeout

    // The whole point: the link/token and the key never reach the logs.
    expect(logText(logs)).not.toContain('SUPER-SECRET-TOKEN');
    expect(logText(logs)).not.toContain(API_KEY);
  });

  it('sends the staff invite with the restaurant name and role', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(response(200, { id: 'msg_2' }));
    global.fetch = fetchMock;

    const { svc } = build();
    await svc.sendStaffInviteEmail('newbie@example.com', {
      restaurantName: 'Momo House',
      roleName: 'Cashier',
      acceptUrl: 'https://app.example.com/join/TOKEN',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    const payload = bodyOf(init);
    expect(payload.subject).toContain('Momo House');
    expect(payload.html).toContain('Cashier');
    expect(payload.text).toContain('https://app.example.com/join/TOKEN');
  });

  it('retries a transient 500 and then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(200, { id: 'msg_3' }));
    global.fetch = fetchMock;

    const { svc } = build();
    await expect(
      svc.sendPasswordResetEmail('user@example.com', RESET_URL),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a network error/timeout and gives up after the attempt budget', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchMock;

    const { svc } = build();
    await expect(
      svc.sendPasswordResetEmail('user@example.com', RESET_URL),
    ).rejects.toBeInstanceOf(MailDeliveryError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a permanent 4xx (bad payload / bad key)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(422));
    global.fetch = fetchMock;

    const { svc } = build();
    await expect(
      svc.sendPasswordResetEmail('user@example.com', RESET_URL),
    ).rejects.toBeInstanceOf(MailDeliveryError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // failed fast, no retry
  });

  it('never puts the token or the API key in the logs, even on failure', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response(500));
    global.fetch = fetchMock;

    const { svc, logs } = build();
    await svc
      .sendPasswordResetEmail('user@example.com', RESET_URL)
      .catch(() => {});

    expect(logText(logs)).not.toContain('SUPER-SECRET-TOKEN');
    expect(logText(logs)).not.toContain(API_KEY);
  });
});

describe('MailService — dev fallback', () => {
  it('does not call the provider when no key is configured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const { svc } = build({ RESEND_API_KEY: undefined, MAIL_FROM: undefined });
    await svc.sendPasswordResetEmail('user@example.com', RESET_URL);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('in production with no provider, warns and logs no body', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const { svc, logs } = build({
      RESEND_API_KEY: undefined,
      MAIL_FROM: undefined,
      NODE_ENV: 'production',
    });
    await svc.send({
      to: 'user@example.com',
      subject: 'x',
      html: '<p>secret body</p>',
      text: 'secret body',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logText(logs)).not.toContain('secret body');
  });
});
