/**
 * Razorpay Orders API client interface and default implementation.
 *
 * The interface (`RazorpayClient`) is the dependency-injection seam that
 * allows tests to stub the external Razorpay HTTP call without nock or
 * network access. The default implementation (`createRazorpayClient`)
 * calls the real Razorpay Orders API using Basic Auth with the
 * configured key_id and key_secret.
 *
 * Design reference: Purchase_Service → Razorpay Orders API (R10.1, R10.2).
 */

/**
 * Input required to create a Razorpay Order.
 */
export interface CreateOrderInput {
  /** Amount in the smallest currency unit (paise for INR). */
  readonly amount: number;
  /** ISO 4217 currency code. Always 'INR' for this system. */
  readonly currency: string;
  /** Razorpay receipt identifier (our purchase id). */
  readonly receipt: string;
  /** Optional notes attached to the order. */
  readonly notes?: Record<string, string>;
}

/**
 * Successful response from the Razorpay Orders API.
 */
export interface CreateOrderResult {
  /** Razorpay order id (e.g. `order_XXXXXXXXXXXXXX`). */
  readonly id: string;
  /** Amount in paise. */
  readonly amount: number;
  /** Currency code. */
  readonly currency: string;
  /** Short URL for hosted checkout (when available). */
  readonly short_url?: string;
}

/**
 * Dependency-injection interface for the Razorpay Orders API.
 * Tests inject a stub; production uses `createRazorpayClient`.
 */
export interface RazorpayClient {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
}

/**
 * Configuration for the default Razorpay client.
 */
export interface RazorpayClientConfig {
  readonly keyId: string;
  readonly keySecret: string;
  /** Base URL override for testing against a local mock server. */
  readonly baseUrl?: string;
}

/**
 * Create a production Razorpay client that calls the real Orders API.
 */
export function createRazorpayClient(config: RazorpayClientConfig): RazorpayClient {
  const baseUrl = config.baseUrl ?? 'https://api.razorpay.com/v1';
  const authHeader =
    'Basic ' + Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');

  return {
    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      const body = JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        receipt: input.receipt,
        ...(input.notes ? { notes: input.notes } : {}),
      });

      const response = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new RazorpayApiError(
          `Razorpay Orders API returned ${response.status}: ${text}`,
          response.status,
        );
      }

      const data = (await response.json()) as {
        id: string;
        amount: number;
        currency: string;
        short_url?: string;
      };

      const result: CreateOrderResult = {
        id: data.id,
        amount: data.amount,
        currency: data.currency,
      };
      if (data.short_url) {
        return { ...result, short_url: data.short_url };
      }
      return result;
    },
  };
}

/**
 * Error thrown when the Razorpay API returns a non-2xx response.
 */
export class RazorpayApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'RazorpayApiError';
    this.statusCode = statusCode;
  }
}
