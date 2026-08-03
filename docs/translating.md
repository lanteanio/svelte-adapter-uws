# Translation contract

This document is the translation boundary shared by
`svelte-adapter-uws`, `svelte-realtime`, and
`svelte-adapter-uws-extensions`. The machine-readable companion is
[`docs/messages.v1.json`](./messages.v1.json).

## Source locale and ownership

The ecosystem has one source locale: English (`en`). Package-owned
diagnostic prose, fallback HTML, documentation, and recovery guidance are
authored in English. English is a fallback, not a promise that the packages
ship a user-interface catalog or negotiate an application locale.

Applications own:

- locale selection, fallback chains, plural rules, date and number formatting;
- message keys and translated end-user prose;
- the decision to expose a bounded, safe diagnostic detail to a user;
- `lang`, `dir`, and bidirectional isolation at the rendered boundary.

Packages own stable machine identifiers and the default English text needed by
operators when an application supplies no presentation layer. Adding English
package prose does not create a stable display-string API.

## Machine fields are not prose

Use declared codes and structured fields for program logic. Keep them
byte-exact and do not translate, case-fold, interpolate into sentences, or
derive behavior by parsing their spelling.

| Surface | Stable machine input | Human text |
| --- | --- | --- |
| Structured diagnostics | `schemaVersion`, `occurredAt`, `source`, `component`, `event`, `severity`, `level`, `dataClass` | `message`; each `attributes` member follows its owning schema |
| Adapter error reference | `id`, nullable `code`, `event`, `component`, `severity`, source paths, anchors, and help routes | problem and message prefixes, cause, consequence, recovery, and next action |
| Subscription denial | the declared `SubscribeDenialReason` members | custom hook `reason` values |
| Connection failure | `kind`, `class`, numeric close `code`, or HTTP `status` | WebSocket and HTTP `reason` text |
| Waiting room | documented `{{token}}` names, BCP 47 `lang`, and `dir` values | the rendered document |
| Protocol and telemetry | frame types, field names, status values, metric names, label names, and enumerated label values | metric help and operator descriptions |
| Application payload | application-defined discriminators only when the application declares them stable | names, content, errors, and other free text |

The registry records these categories for tooling. Its `contextFields` are
structured containers whose members must be classified by their owning schema;
they are not translated as a unit and are not assumed to be prose. A field is
stable only when its public type, schema, or registry enumerates it. A property
named `reason` is not automatically a reason code: for example, a declared
`SubscribeDenialReason` member can select an application message key, while a
custom denial string or WebSocket close reason is diagnostic text.

Applications should map known machine values to their own keys and use a safe
generic fallback:

```js
const denialKeys = {
  UNAUTHENTICATED: 'subscription.denied.unauthenticated',
  FORBIDDEN: 'subscription.denied.forbidden',
  INVALID_TOPIC: 'subscription.denied.invalid-topic',
  RATE_LIMITED: 'subscription.denied.rate-limited'
};

const messageKey = denialKeys[denial.reason] ?? 'subscription.denied';
```

Do not render an `Error.message`, diagnostic `message`, custom denial
`reason`, auth response text, or close reason as trusted end-user copy. Do not
match or alert on those strings. Route diagnostics by their stable fields, then
keep the English message as operator context or place a deliberately selected,
escaped detail behind application-owned localized prose.

## Placeholders

Package templates use named placeholders. Their names and braces are machine
syntax and must remain byte-exact; only the surrounding prose is translated.

- Never assign positional meaning to placeholder order.
- Format dates, numbers, lists, and units for the selected locale before
  interpolation.
- Do not build a sentence by concatenating separately translated fragments.
- Give translators a description and a representative value for every
  application-owned placeholder.
- Reject missing, unknown, or malformed package template tokens. The waiting
  room compiler already fails configuration on an unknown token or unclosed
  `{{`.
- Escape or encode every value for its destination context after formatting.

The waiting-room token set is documented by the adapter option and is listed in
the registry. Token values are escaped by the built-in template boundary.
Application renderer modules return trusted HTML and therefore own contextual
escaping themselves.

## Bidirectional text

Translated prose follows the selected locale's natural direction. Machine
identifiers retain their original direction and bytes.

Canonical console diagnostics keep package-owned messages and routing fields
physically ASCII-safe. Externally supplied topic, path, name, and error values
belong in the structured `attributes` object; its JSON escapes are decoded by
`parseDiagnostic()`. A renderer must escape those decoded values for its
destination and apply the HTML or plain-text isolation below.

- Set a valid BCP 47 `lang` and the matching `dir` on the document or
  component boundary.
- Isolate an external name, identifier, URL, or diagnostic value with
  `<bdi dir="auto">` in HTML, or with FIRST STRONG ISOLATE (U+2068) and POP
  DIRECTIONAL ISOLATE (U+2069) in plain text.
- Do not insert directional override controls into generated strings.
- Remove unexpected control and bidirectional formatting characters from
  untrusted display values before storage or rendering when preserving them is
  not an explicit application requirement.
- Keep protocol tokens, log routing values, metric labels, and translation
  keys outside translated prose.

HTML escaping and bidirectional isolation solve different problems; apply both
when an untrusted value is embedded in a translated sentence.

## Waiting-room localization

The built-in waiting room is the English fallback. To localize it per request,
provide a synchronous `waitingRoom.renderer` that returns a complete document
with `body`, `lang`, and `dir`. The adapter writes `Content-Language`,
makes `lang` and `dir` authoritative on `<html>`, and varies the response
on `Accept-Language`. Invalid or throwing renderers fall back to the built-in
English page.

A string `waitingRoom.template` is one application-owned document, not a
locale catalog. Applications that need negotiation, pluralization, or
right-to-left output should use a renderer and their normal catalog.

## Change rule

When a package adds or changes a public text surface:

1. Classify its stable selectors and human fields in
   [`docs/messages.v1.json`](./messages.v1.json).
2. Keep machine identifiers independent from the English text.
3. Document any named placeholders and their escaping boundary.
4. Add a changelog entry and executable contract coverage.

Changing diagnostic wording is a documentation change. Changing a declared
code, event, frame field, metric name, or other machine identifier requires the
compatibility and migration treatment owned by that interface.

See [`observability.md`](./observability.md) for structured routing and data
classes, [`docs/errors.md`](./errors.md) for the generated adapter error
reference, and [`PROTOCOL.md`](../PROTOCOL.md) for wire stability.
