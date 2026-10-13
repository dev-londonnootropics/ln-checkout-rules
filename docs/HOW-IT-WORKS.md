# How the phone rule works

This document explains every file in `ln-checkout-rules`: what it is, what it does, and whether you ever need to touch it.

---

## 1. The big picture

**Goal:** one phone field at checkout. Optional for UK (GB) addresses, required for every other country.

**How:** Shopify's native "Shipping address phone number" setting is set to **Optional**. On top of that, a small program called a **Shopify Function** runs inside Shopify's servers every time a customer interacts with checkout. It looks at the delivery address and, if the country is not GB and the phone is empty, it tells Shopify "block this and show an error on the phone field".

```
Customer types in checkout
        │
        ▼
Shopify collects the data our query asks for       ← src/cart_validations_generate_run.graphql
(checkout step, delivery country, delivery phone)
        │
        ▼
Shopify runs our function with that data           ← src/cart_validations_generate_run.js
        │
        ├── no problems → returns nothing → checkout continues
        │
        └── non-UK + empty phone → returns an error
                │
                ▼
     Shopify shows "Please enter a phone number for international delivery."
     under the phone field and won't let the order complete
```

Key facts:
- The code runs **on Shopify's servers**, not on our site or in the customer's browser. Customers can't bypass it with browser tricks.
- It also applies to **accelerated checkouts** (Shop Pay, Apple Pay, Google Pay, PayPal).
- We don't host anything. There's no server, database or monthly cost.
- The code is compiled to **WebAssembly** (`.wasm`), a small fast format Shopify requires for Functions. `shopify app deploy` does this for you.

---

## 2. Folder map

```
ln-checkout-rules/
├── shopify.app.toml                 App identity + settings          (important)
├── package.json / package-lock.json Dependencies list                (rarely touched)
├── .npmrc                           npm settings                     (rarely touched)
├── .gitignore                       What Git should not upload       (rarely touched)
├── .graphqlrc.js                    Editor helper for GraphQL        (never touched)
├── README.md                        Short project overview
├── docs/HOW-IT-WORKS.md             This file
├── AGENTS.md / CLAUDE.md / mcp.json Hints for AI coding tools        (optional)
├── CHANGELOG.md / SECURITY.md       Template boilerplate             (optional)
├── vite.config.ts, shared/          Leftovers from Shopify's FAQ sample (unused, safe to delete)
└── extensions/
    └── phone-required-international/       ← THE RULE
        ├── shopify.extension.toml           Tells Shopify what this extension is
        ├── locales/en.default.json          Name/description shown in Shopify admin
        ├── schema.graphql                   Shopify's data dictionary (auto-generated)
        ├── src/
        │   ├── cart_validations_generate_run.graphql   What data we ask Shopify for
        │   ├── cart_validations_generate_run.js        THE LOGIC
        │   └── index.js                                 Entry point that exposes the logic
        ├── tests/
        │   ├── default.test.js              Test runner
        │   └── fixtures/*.json              5 test scenarios
        ├── package.json                     Extension's own dependencies + scripts
        ├── vite.config.js / vitest.config.js  Test tool settings
        └── .gitignore                       Ignores build output
```

Not in Git (ignored, recreated automatically): `node_modules/` (downloaded packages), `dist/` (compiled `.wasm`), `generated/` (auto-generated types), `.shopify/` (local dev settings).

---

## 3. The rule itself (the files that matter)

### 3.1 `src/cart_validations_generate_run.graphql` — the "shopping list"

```graphql
query CartValidationsGenerateRunInput {
  buyerJourney {
    step
  }
  cart {
    deliveryGroups {
      deliveryAddress {
        countryCode
        phone
      }
    }
  }
}
```

A Shopify Function can't look things up on its own. Instead, this file tells Shopify exactly which pieces of data to hand over before each run. Shopify only sends what's listed, which keeps it fast.

| Field | What it is | Example |
|---|---|---|
| `buyerJourney.step` | Where the customer is right now | `CART_INTERACTION`, `CHECKOUT_INTERACTION`, `CHECKOUT_COMPLETION` |
| `cart.deliveryGroups` | A list of shipments. Usually 1, but can be more with split shipping | `[ {...}, {...} ]` |
| `deliveryAddress.countryCode` | Two-letter country code of the shipping address | `"GB"`, `"US"`, `"AE"` |
| `deliveryAddress.phone` | The phone typed in the shipping address (can be empty/null) | `"+971501234567"` or `null` |

The query name `CartValidationsGenerateRunInput` must stay as it is; the code and type generator rely on it.

### 3.2 `src/cart_validations_generate_run.js` — the logic

Walkthrough, block by block:

```js
// @ts-check
```
Turns on type checking in code editors (VS Code), so mistakes like misspelling `countryCode` get underlined. Has no effect when running.

```js
/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} ...
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} ...
 */
```
Comments that point the editor to auto-generated type definitions (created by `npm run typegen` from the `.graphql` file + `schema.graphql`). Also editor-only.

```js
const PHONE_OPTIONAL_COUNTRIES = ["GB"];
```
**The list of countries where phone stays optional.** Only the UK today. To add, e.g., Isle of Man and Channel Islands: `["GB", "IM", "JE", "GG"]`. This is the line you're most likely to change in future.

```js
const MESSAGE = "Please enter a phone number for international delivery.";
```
**The error text customers see.** Change the wording here.

```js
export function cartValidationsGenerateRun(input) {
```
The function Shopify calls. `input` contains exactly the data requested in the `.graphql` file. The name must match the export configured in `shopify.extension.toml` (Shopify converts `cart-validations-generate-run` ↔ `cartValidationsGenerateRun`).

```js
  const step = input.buyerJourney?.step;
  if (step !== "CHECKOUT_INTERACTION" && step !== "CHECKOUT_COMPLETION") {
    return { operations: [] };
  }
```
**Guard 1 – only run in checkout.** Validation Functions also run when someone adds to cart or edits the cart (`CART_INTERACTION`). At that point there's no address, and an error there could block adding to cart. So outside checkout we return "no operations" = no errors. The `?.` means "if `buyerJourney` is missing, don't crash, just treat it as undefined".

```js
  const errors = [];
  const groups = input.cart?.deliveryGroups ?? [];
```
Start an empty list of errors. Get the list of shipments; if there are none, use an empty list (`?? []`) so the loop below doesn't crash.

```js
  groups.forEach((group, i) => {
    const address = group.deliveryAddress;
    if (!address || !address.countryCode) return;
```
Go through each shipment (`i` is its position: 0, 1, 2…).
**Guard 2 – skip shipments with no address yet**, e.g. the customer hasn't filled the form, or it's a local pickup. `return` here means "skip to the next shipment".

```js
    if (PHONE_OPTIONAL_COUNTRIES.includes(address.countryCode)) return;
```
**Guard 3 – UK is exempt.** If the country is in the optional list, skip.

```js
    const phone = (address.phone ?? "").trim();
    if (phone === "") {
      errors.push({
        message: MESSAGE,
        target: `$.cart.deliveryGroups[${i}].deliveryAddress.phone`,
      });
    }
  });
```
**The actual rule.** Take the phone (or `""` if it's null), remove spaces from both ends (`trim`, so `"   "` counts as empty), and if it's empty, add an error.
- `message` – what the customer sees.
- `target` – *where* Shopify shows it. This path means "the phone field of shipment number `i`", so the red message appears right under the phone box instead of at the top of the page.

```js
  if (errors.length === 0) return { operations: [] };
  return { operations: [{ validationAdd: { errors } }] };
}
```
Send the result back to Shopify:
- No errors → `{ operations: [] }` → checkout continues.
- Errors → a `validationAdd` operation containing them → Shopify blocks completion and shows the messages.

**What the rule does NOT do:** it doesn't check the phone is a *valid* number (Shopify's own field already does basic formatting), doesn't touch billing phone, doesn't change the UK experience, and doesn't add or remove any field.

### 3.3 `src/index.js`

```js
export * from './cart_validations_generate_run';
```
The single entry point Shopify's build tool reads. It re-exports our function. If you ever added a second function target to this extension, you'd add another line here. Otherwise never touched.

### 3.4 `shopify.extension.toml` — the extension's ID card

```toml
api_version = "2026-07"
```
Which version of Shopify's Functions API we use. Shopify releases a new version each quarter; each is supported for about a year. Update this roughly once a year (then run `npm run typegen` + tests).

```toml
[[extensions]]
name = "t:name"
handle = "phone-required-international"
type = "function"
uid = "f3378022-…"
description = "t:description"
```
- `name` / `description` = `t:` means "translate": read them from `locales/en.default.json`.
- `handle` – permanent internal name. Don't change it, or Shopify treats it as a brand-new extension and the existing checkout rule would break.
- `type = "function"` – it's a Shopify Function (runs on Shopify's servers).
- `uid` – unique ID Shopify assigned. Never change.

```toml
  [[extensions.targeting]]
  target = "cart.validations.generate.run"
  input_query = "src/cart_validations_generate_run.graphql"
  export = "cart-validations-generate-run"
```
- `target` – "this is a Cart and Checkout Validation function". That's why it shows up under **Settings → Checkout → Checkout rules**.
- `input_query` – which `.graphql` file defines the input.
- `export` – which JavaScript function to call.

```toml
  [extensions.build]
  command = ""
  path = "dist/function.wasm"
```
Where the compiled WebAssembly ends up. The empty `command` means "use Shopify's default JavaScript build".

### 3.5 `locales/en.default.json`

```json
{
  "name": "Phone required outside UK",
  "description": "Requires a shipping phone number for any delivery address outside the United Kingdom."
}
```
The human-readable name and description shown in Shopify admin (Checkout rules list, app pages). Safe to edit. Note: the rule *title* you see in Checkout rules can also be edited directly in admin.

### 3.6 `schema.graphql`

A large file (≈100 KB) downloaded by the Shopify CLI. It's Shopify's dictionary of every field a validation function *could* ask for. Used by the type generator, editor autocompletion and tests. Never edit by hand; it's refreshed by the CLI when `api_version` changes.

---

## 4. Tests

### 4.1 `tests/default.test.js` — the test runner

Run with `npm test` inside the extension folder. For each JSON file in `tests/fixtures/`, it:
1. **Builds** the function into `.wasm` (same as production).
2. **Validates** the fixture: checks the fake input matches the GraphQL query and schema, and the expected output is a valid response shape. Catches typos like asking for a field that doesn't exist.
3. **Runs** the real compiled function with the fake input using Shopify's official runner.
4. **Compares** the actual result with the fixture's expected output. Any difference = test fails.

This is Shopify's standard template; we didn't change it.

### 4.2 `tests/fixtures/*.json` — the scenarios

Each file is a fake checkout (`input`) plus the answer we expect (`output`).

| File | Situation | Expected |
|---|---|---|
| `uk-no-phone.json` | GB address, phone empty, completing checkout | No error |
| `us-no-phone.json` | US address, phone empty, completing checkout | Error on shipment 0's phone field |
| `ae-with-phone.json` | UAE address with phone | No error |
| `cart-step-ignored.json` | US address, no phone, but customer is only in the cart | No error (rule skipped) |
| `split-shipping-second-missing.json` | 2 shipments: US with phone, France without | Error on shipment **1**'s phone field only |

To add a scenario: copy one file, change the input and expected output, run `npm test`.

### 4.3 `vitest.config.js` and `vite.config.js`

- `vitest.config.js` – settings for Vitest (the test tool): re-run tests automatically when fixtures or source files change.
- `vite.config.js` – intentionally empty. Stops the extension accidentally inheriting the root `vite.config.ts` (which belongs to the unused FAQ sample).

### 4.4 Extension `package.json`

```json
"scripts": {
  "typegen": "shopify app function typegen",   // regenerate types from the .graphql
  "build":   "shopify app function build",     // compile to dist/function.wasm
  "preview": "shopify app function run",       // run once with a JSON input you paste
  "test":    "vitest"                          // run the fixtures
}
```
- `@shopify/shopify_function` – Shopify's library that turns our JavaScript into a Function.
- `@shopify/shopify-function-test-helpers` and `vitest` – used only for tests (dev dependencies).
- The `codegen` block configures `typegen`: read `schema.graphql` + `src/*.graphql`, write types to `generated/api.ts`.

---

## 5. App-level files (root)

### `shopify.app.toml` — the app's ID card
- `client_id` – links this code to the **ln-checkout-rules** app in the Dev Dashboard. Not a secret, but don't change it or deploys go to a different app.
- `name` – app name.
- `application_url`, `embedded`, `[auth] redirect_urls` – placeholders for apps with an admin page. Ours has none, so Shopify's default placeholder URLs are used. Harmless.
- `[build] include_config_on_deploy = true` – deploys push these settings too.
- `[access_scopes] scopes = ""` – the app asks for **no permissions** to store data (products, orders, customers). Functions get their data only from the query, so none are needed.
- `[webhooks] api_version` – unused (no webhooks).

### `package.json` (root)
- `workspaces: ["extensions/*"]` – one `npm install` at the root installs dependencies for every extension.
- `scripts` – shortcuts: `npm run deploy` = `shopify app deploy`, `npm run dev` = `shopify app dev`, etc.
- `trustedDependencies` – template leftover, harmless.

### `package-lock.json`
Exact versions of every downloaded package, so everyone installs identical versions. Auto-maintained by npm. Commit it, never edit it.

### `.npmrc`
- `engine-strict=true` – refuse to install if Node is too old. (That's what caused the "Required node >=22.15" error earlier.)
- `@shopify:registry=…` – download `@shopify/*` packages from the public npm registry.

### `.gitignore`
Keeps `node_modules`, `dist`, `generated`, `.env` files, logs and `.shopify/` out of GitHub. They're either huge, machine-specific, or rebuilt automatically.

### `.graphqlrc.js`
Helper for code editors: finds each extension's `schema.graphql` so GraphQL files get autocompletion. Doesn't affect the live rule.

### `AGENTS.md`, `CLAUDE.md`, `mcp.json`
Instructions and a tool connection for AI coding assistants (e.g. Shopify's docs assistant). Optional; no effect on the rule.

### `CHANGELOG.md`, `SECURITY.md`
Template boilerplate. You can use CHANGELOG to note future changes.

### `vite.config.ts`, `shared/models/faq.ts`, `shared/utils/gid.ts`
**Leftovers from Shopify's FAQ sample app** (the `app-home` / `app-tools` extensions we removed). Nothing uses them. Safe to delete in a later cleanup commit.

---

## 6. Common changes

| I want to… | Do this |
|---|---|
| Make another country optional | Add its code to `PHONE_OPTIONAL_COUNTRIES` in the `.js` file |
| Change the error wording | Edit `MESSAGE` in the `.js` file |
| Turn the rule off now | Shopify admin → Settings → Checkout → Checkout rules → set Inactive |
| Ship any code change | `cd extensions/phone-required-international && npm test` → `cd ../.. && shopify app deploy` → commit + push in GitHub Desktop |

No admin change is needed after a deploy. The active rule automatically uses the newly released version.

---

## 7. Monitoring

- **Function runs and errors:** Dev Dashboard → ln-checkout-rules → **Logs** (or Monitoring). Each run shows its input, output and any failure.
- **Behaviour:** watch international conversion and customer service messages about the phone field for the first days.
- **Safety net:** "Block checkout if app experiences a problem" is **off**, so if the function ever crashes or times out, checkout proceeds without the rule.
