# ln-checkout-rules

Shopify extension-only app for London Nootropics checkout rules.

## Extensions

### phone-required-international (Cart and Checkout Validation Function)
- Shipping phone number is **optional for UK (GB)** and **required for every other country**.
- Error shown on the native shipping phone field: "Please enter a phone number for international delivery."
- Only enforced during checkout (not cart), checks every delivery group (split shipping), ignores groups without an address.
- To add more phone-optional countries, edit `PHONE_OPTIONAL_COUNTRIES` in `extensions/phone-required-international/src/cart_validations_generate_run.js`.

Store setup: Settings → Checkout → Shipping address phone number = **Optional**; Checkout rules → "Phone required outside UK" = **On**.
Rollback: turn the rule off in Checkout rules.

## Requirements
- Node 22.15+ (LTS recommended), npm
- Shopify CLI: `npm install -g @shopify/cli@latest`

## Develop
```
npm install
cd extensions/phone-required-international
npm run typegen
npm run build
npm test
```

## Deploy
From the repo root: `shopify app deploy`
