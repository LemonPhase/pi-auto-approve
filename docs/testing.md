# Testing without model quota

Use:

```sh
npm run test:local
```

This is the normal verification path. It runs the Node test suite directly. The tests load the pinned Pi extension types and loader, then invoke the extension and wrapped native tools with fixed inputs. The classifier is a fake injected implementation, and approval answers are fixed values such as `allow_once` and `reject`.

It does not spawn the `pi` executable, read provider credentials, call an LLM, or consume model quota. It does depend on the Pi package installed in this project’s `node_modules` so that extension compatibility is checked against the pinned Pi API.

Use `npm run test:live` only when you specifically want to verify a real installed Pi session. That command starts `pi` twice, asks the configured model to produce harmless marker commands, and therefore needs a provider and may consume quota.

The extension itself has no runtime dependency on your personal Pi state beyond Pi loading it. Its configuration is read from the current agent directory and project directory during a real session, and its audit path defaults under the agent directory. The local tests redirect those paths to temporary directories. The live tests also use temporary project directories and do not change your global approval configuration.

Jev classification is exercised with a stub HTTP server that implements the documented request/response shape, so no API key and no external request are involved. `npm run test:eval` is the one command that calls the real Jev service; it needs `TYPESAFE_API_KEY` and consumes quota.
