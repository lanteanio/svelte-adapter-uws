# Platform member inventory

`svelte-adapter-uws/platform-contract` is a supported, dependency-free entry
point for wrappers and mocks that must keep the complete public `Platform`
surface. It exports the frozen `PLATFORM_MEMBERS` array and the TypeScript
`PlatformMember` name union. The inventory includes inherited methods, readable
properties such as `metrics` and `traceContext`, and contextual fields such as
`requestId`. Symbol-keyed runtime internals and plugin-added members are outside
this public inventory.

```js
import { PLATFORM_MEMBERS } from 'svelte-adapter-uws/platform-contract';

export function forwardPlatform(source) {
  const forwarded = {};
  for (const name of PLATFORM_MEMBERS) {
    if (!(name in source)) continue;
    Object.defineProperty(forwarded, name, {
      enumerable: true,
      get() {
        const value = source[name];
        return typeof value === 'function' ? value.bind(source) : value;
      }
    });
  }
  return forwarded;
}
```

Read through the source to retain live getters and invoke methods with their
original receiver. A wrapper that replaces a method must preserve that
method's documented behavior, including locality and return semantics.

This array is an inventory of the uWS contract. It does not certify an
arbitrary object, select an adapter by heuristics, or require another adapter
to implement every member. Wrappers of other adapters preserve absent members;
they must use that adapter's declared capabilities before requiring a method.
Per-request fields are available on a request or connection platform rather
than the unbound worker base object. Plugin-added fields need the plugin's own
contract.

The inventory is generated from the complete public `Platform` declaration.
`node scripts/generate-platform-contract.js --check` rejects drift, and a
real-connection test compares the exported names against the running handler
platform. After changing `Platform`, run the generator and keep the runtime
and declaration in agreement. Consumers import this export or generate from
it instead of maintaining another list.
