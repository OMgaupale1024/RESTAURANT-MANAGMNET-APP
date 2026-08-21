import type { ConfigService } from '@nestjs/config';
import {
  MenuExtractionError,
  MenuExtractionService,
  StubExtractionProvider,
  type MenuExtractionProvider,
} from './menu-extraction.service';

/**
 * The schema gate in front of the catalogue. AI/provider output is UNTRUSTED
 * input (spec §22, prompt-injection §23): whatever a model returns, only a shape
 * that passes RawMenuSchema may proceed — everything else collapses to a
 * plain-language MenuExtractionError, never a stack trace and never a product.
 */

// No env keys -> the service builds a StubExtractionProvider. We then swap the
// provider to drive each failure path deterministically.
const noEnv = { get: () => undefined } as unknown as ConfigService;
const withProvider = (p: MenuExtractionProvider): MenuExtractionService => {
  const svc = new MenuExtractionService(noEnv);
  (svc as unknown as { provider: MenuExtractionProvider }).provider = p;
  return svc;
};
const fake = (extract: () => Promise<unknown>): MenuExtractionProvider => ({
  name: 'fake',
  extract,
});

describe('MenuExtractionService (untrusted-output gate)', () => {
  it('defaults to the deterministic stub when no API key is set', async () => {
    const svc = new MenuExtractionService(noEnv);
    expect(svc.providerName).toBe('stub');
    const menu = await svc.extract(['data:image/png;base64,AA']);
    expect(menu.categories.length).toBeGreaterThan(0);
  });

  it('rejects a structurally wrong response', async () => {
    const svc = withProvider(fake(() => Promise.resolve({ nope: true })));
    await expect(svc.extract(['x'])).rejects.toBeInstanceOf(
      MenuExtractionError,
    );
  });

  it('rejects a response that smuggles a bad field type', async () => {
    // price as a string, name empty — the kind of thing a hallucination emits.
    const svc = withProvider(
      fake(() =>
        Promise.resolve({
          categories: [{ name: 'X', items: [{ name: '', price: 'free' }] }],
        }),
      ),
    );
    await expect(svc.extract(['x'])).rejects.toBeInstanceOf(
      MenuExtractionError,
    );
  });

  it('rejects a well-formed but empty menu (nothing to import)', async () => {
    const svc = withProvider(fake(() => Promise.resolve({ categories: [] })));
    await expect(svc.extract(['x'])).rejects.toBeInstanceOf(
      MenuExtractionError,
    );
  });

  it('maps a provider throw to a plain-language error, not the raw cause', async () => {
    const svc = withProvider(
      fake(() => Promise.reject(new Error('ECONNRESET tcp://secret-host'))),
    );
    await expect(svc.extract(['x'])).rejects.toThrow(
      /couldn't read this menu/i,
    );
  });

  it('accepts and returns a valid menu unchanged in shape', async () => {
    const svc = withProvider(new StubExtractionProvider());
    const menu = await svc.extract(['x']);
    expect(menu.categories[0].items[0]).toHaveProperty('name');
    expect(typeof menu.categories[0].items[0].price === 'number').toBe(true);
  });
});
