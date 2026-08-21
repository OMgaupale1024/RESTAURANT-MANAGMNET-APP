import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { RawMenuSchema, type RawMenu } from './menu-import.types';

/**
 * Menu extraction, behind a provider interface (spec §22). The rest of OraOS
 * never learns which model ran — it asks for images in, a validated RawMenu
 * out, and gets an honest MenuExtractionError when the menu can't be read.
 */

/**
 * Thrown when a menu cannot be read — an upstream failure, a timeout, or a
 * response that does not match the schema. Carries a user-facing message; the
 * orchestration turns it into a 422 and marks the session FAILED. Distinct from
 * a programming error so only the honest "we couldn't read it" surfaces to the
 * user (spec §19), never a stack trace.
 */
export class MenuExtractionError extends Error {}

const EXTRACTION_TIMEOUT_MS = 60_000;

/** One provider that turns images into a raw menu structure. Swappable. */
export interface MenuExtractionProvider {
  readonly name: string;
  /** Returns parsed-but-unvalidated JSON; the service validates the shape. */
  extract(images: string[]): Promise<unknown>;
}

/**
 * Deterministic, no-network extractor. Used when MENU_AI_API_KEY is unset — so
 * local dev and the whole e2e suite run the real flow with no provider and no
 * spend — and as the honest fallback the app boots with. Mirrors the spec's
 * momos + fries example so a scan produces something recognisable, including one
 * low-confidence line for the review UI to flag.
 */
export class StubExtractionProvider implements MenuExtractionProvider {
  readonly name = 'stub';
  extract(_images: string[]): Promise<unknown> {
    return Promise.resolve({
      categories: [
        {
          name: 'Momos',
          confidence: 0.98,
          items: [
            {
              name: 'Veg Momos',
              price: 60,
              quantity: '7 pcs',
              veg: true,
              confidence: 0.98,
            },
            {
              name: 'Paneer Momos',
              price: 80,
              quantity: '7 pcs',
              veg: true,
              confidence: 0.97,
            },
            {
              name: 'Cheese Momos',
              price: 100,
              quantity: '7 pcs',
              veg: true,
              confidence: 0.95,
            },
          ],
        },
        {
          name: 'Fries',
          confidence: 0.9,
          items: [
            { name: 'Classic Fries', price: 80, veg: true, confidence: 0.94 },
            {
              name: 'Peri Peri Fries',
              price: 100,
              veg: true,
              confidence: 0.61,
            },
          ],
        },
      ],
    });
  }
}

const PROMPT = `You are a menu digitiser for a restaurant POS. Read the attached menu photo(s) and return the menu as STRICT JSON, nothing else.

Rules:
- Understand the STRUCTURE: group items under their category headings.
- If several photos are pages of one menu, merge them into one menu; do not duplicate an item that appears on more than one page.
- price: the number as printed, in the menu's own currency units (e.g. 60 for the price shown as 60 or ₹60). Use null if no price is shown. Never invent a price.
- quantity: portion text like "7 pcs" or "500 ml". variant: a size/option like "Large". Omit either if absent.
- veg: true for a clearly vegetarian item, false for clearly non-veg, null if unknown. spicy: true only if the menu marks it.
- confidence: 0..1, how sure you are of that item (or category). Lower it for blurry, ambiguous, or guessed text.
- Do NOT include commentary, markdown, or code fences. Output only the JSON object.

Shape:
{"categories":[{"name":"string","confidence":0.0,"items":[{"name":"string","price":0,"description":"string|null","quantity":"string|null","variant":"string|null","veg":true,"spicy":false,"confidence":0.0}]}]}`;

/**
 * OpenAI-compatible vision extractor. Talks to OpenAI by default, or to any
 * OpenAI-compatible endpoint via `baseURL` — notably Gemini's, which lets us use
 * Gemini 2.5 Flash through the same SDK with no extra dependency. Structured
 * JSON out; the SERVICE validates it with zod, so a hallucinated shape never
 * reaches the catalogue.
 */
export class OpenAiExtractionProvider implements MenuExtractionProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(opts: {
    apiKey: string;
    model: string;
    /** Undefined ⇒ OpenAI's default endpoint. */
    baseURL?: string;
    /** Honest label for the audit trail, e.g. 'openai' or 'gemini'. */
    name?: string;
  }) {
    this.name = opts.name ?? 'openai';
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: EXTRACTION_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  async extract(images: string[]): Promise<unknown> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            ...images.map((url) => ({
              type: 'image_url' as const,
              image_url: { url, detail: 'high' as const },
            })),
          ],
        },
      ],
    });
    const text = res.choices[0]?.message?.content;
    if (!text)
      throw new MenuExtractionError('The menu reader returned nothing.');
    // May throw on malformed JSON — caught and normalised by the service below.
    return JSON.parse(text) as unknown;
  }
}

@Injectable()
export class MenuExtractionService {
  private readonly logger = new Logger(MenuExtractionService.name);
  private readonly provider: MenuExtractionProvider;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('MENU_AI_API_KEY');
    const baseURL = config.get<string>('MENU_AI_BASE_URL');
    const isGemini = !!baseURL && /google/i.test(baseURL);
    // Default the model to the right family so a Gemini base URL does not need a
    // model set too (a mismatched model is a confusing failure otherwise).
    const model =
      config.get<string>('MENU_AI_MODEL') ??
      (isGemini ? 'gemini-2.5-flash' : 'gpt-4o');
    this.provider = apiKey
      ? new OpenAiExtractionProvider({
          apiKey,
          model,
          baseURL,
          name: baseURL
            ? isGemini
              ? 'gemini'
              : 'openai-compatible'
            : 'openai',
        })
      : new StubExtractionProvider();
  }

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Images → validated RawMenu. Every failure path collapses to a
   * MenuExtractionError with a plain-language message; the raw cause is logged,
   * never shown (spec §19).
   */
  async extract(images: string[]): Promise<RawMenu> {
    let raw: unknown;
    try {
      raw = await this.provider.extract(images);
    } catch (e) {
      this.logger.warn(
        `extraction failed via ${this.provider.name}: ${String(e)}`,
      );
      if (e instanceof MenuExtractionError) throw e;
      throw new MenuExtractionError(
        "We couldn't read this menu. Please try clearer, well-lit photos.",
      );
    }

    const parsed = RawMenuSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`extraction schema mismatch: ${parsed.error.message}`);
      throw new MenuExtractionError(
        "We couldn't confidently read this menu. Please try again.",
      );
    }

    const itemCount = parsed.data.categories.reduce(
      (n, c) => n + c.items.length,
      0,
    );
    if (itemCount === 0) {
      throw new MenuExtractionError(
        "We couldn't find any menu items in these photos.",
      );
    }
    return parsed.data;
  }
}
