// @ts-check

/**
 * London Nootropics — international delivery phone rule
 *
 * Native "Shipping address phone number" stays OPTIONAL in Shopify settings.
 * This function makes it REQUIRED for any delivery address outside the UK.
 *
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// Countries where the phone stays optional. Add more ISO codes here if needed
// (e.g. "IM", "JE", "GG" for Isle of Man / Channel Islands).
const PHONE_OPTIONAL_COUNTRIES = ["GB"];

const MESSAGE = "Please enter a phone number for international delivery.";

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  // Only enforce inside checkout — never block cart / add-to-cart.
  const step = input.buyerJourney?.step;
  if (step !== "CHECKOUT_INTERACTION" && step !== "CHECKOUT_COMPLETION") {
    return { operations: [] };
  }

  const errors = [];
  const groups = input.cart?.deliveryGroups ?? [];

  groups.forEach((group, i) => {
    const address = group.deliveryAddress;
    // No address yet (or pickup) — nothing to validate.
    if (!address || !address.countryCode) return;

    if (PHONE_OPTIONAL_COUNTRIES.includes(address.countryCode)) return;

    const phone = (address.phone ?? "").trim();
    if (phone === "") {
      errors.push({
        message: MESSAGE,
        target: `$.cart.deliveryGroups[${i}].deliveryAddress.phone`,
      });
    }
  });

  if (errors.length === 0) return { operations: [] };
  return { operations: [{ validationAdd: { errors } }] };
}
