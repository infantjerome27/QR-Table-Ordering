// Payment provider abstraction.
//
// SECURITY: card details are NEVER collected, transmitted, or stored by
// this server. Payment is always completed on the provider's hosted
// page (Stripe Checkout / Razorpay Checkout). We only store the
// provider's payment reference and its status.
//
// Providers:
//   mock     - demo provider: instantly "approves" so the full flow can
//              be tested end to end without keys. Never use in prod.
//   stripe   - real Stripe Checkout. Set STRIPE_SECRET_KEY and
//              STRIPE_WEBHOOK_SECRET. Requires the `stripe` npm package;
//              the code path is written so it can be dropped in.
//   razorpay - real Razorpay Checkout. Set RAZORPAY_KEY_ID /
//              RAZORPAY_KEY_SECRET. Same drop-in shape as Stripe.
//
// To switch: PAYMENT_PROVIDER=stripe|razorpay|mock (default: mock).
const crypto = require("crypto");

function createPayment(provider, { billId, amountCents, currency = "usd", returnUrl }) {
  const ref = `pay_${crypto.randomBytes(10).toString("hex")}`;
  if (provider === "mock") {
    // Demo only: no real money moves. The guest confirms on our own
    // page, which simulates the provider redirecting back.
    return {
      providerRef: ref,
      status: "requires_action",
      checkoutUrl: `${returnUrl}?mock_pay=${ref}`,
    };
  }
  if (provider === "stripe") {
    // Drop-in (requires `npm i stripe` and STRIPE_SECRET_KEY):
    //   const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    //   const session = await stripe.checkout.sessions.create({
    //     mode: "payment",
    //     line_items: [{ quantity: 1, price_data: {
    //       currency, unit_amount: amountCents,
    //       product_data: { name: `Table bill ${billId}` } } }],
    //     success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
    //     cancel_url: `${returnUrl}?cancelled=1`,
    //   });
    //   return { providerRef: session.id, status: "requires_action",
    //            checkoutUrl: session.url };
    throw new Error("Stripe provider not configured: set STRIPE_SECRET_KEY and install the stripe package (see README).");
  }
  if (provider === "razorpay") {
    // Drop-in (requires `npm i razorpay` and RAZORPAY_KEY_ID/SECRET):
    //   const Razorpay = require("razorpay");
    //   const rz = new Razorpay({ key_id, key_secret });
    //   const order = await rz.orders.create({ amount: amountCents,
    //     currency: currency.toUpperCase(), receipt: billId });
    //   return { providerRef: order.id, status: "requires_action",
    //            checkoutUrl: `${returnUrl}?razorpay_order=${order.id}` };
    // The guest then pays in Razorpay Checkout; verify the signature
    // server-side on the callback before marking the bill paid.
    throw new Error("Razorpay provider not configured: set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET and install the razorpay package (see README).");
  }
  throw new Error(`Unknown payment provider: ${provider}`);
}

// Webhook verification entry point. For Stripe, verify the signature
// with STRIPE_WEBHOOK_SECRET before trusting the event; for Razorpay,
// verify razorpay_signature with HMAC-SHA256. The mock provider has
// no webhook — confirmation happens via /api/payments/:ref/confirm.
function verifyWebhook(provider, rawBody, signature) {
  if (provider === "mock") return { type: "payment_confirmed" };
  throw new Error(`Webhook verification not configured for ${provider}. See payments.js.`);
}

module.exports = { createPayment, verifyWebhook };
