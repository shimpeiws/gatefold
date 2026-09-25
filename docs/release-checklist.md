# v0.1 release checklist

Reproducible steps to cut the v0.1 release. Every step must pass in order.

## 1. Clean install

```text
git clone <repo> && cd gatefold   # or a fresh checkout of the release commit
pnpm install --frozen-lockfile
```

## 2. Verification gate

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test --run
pnpm build
```

`pnpm ci:all` runs all five in this order and must stay in sync with the
release gate in [v0.1 scope](v0.1-scope.md).

## 3. Package validation

```text
npm pack --dry-run --json
```

Confirm the tarball contains `bin/gatefold.js`, `dist/` (compiled output and
`.d.ts` files), `docs/`, `schema/` (including `schema/examples/`), `README.md`,
and `package.json`. All of `docs/` is shipped intentionally — keep only
public-facing documentation in that directory. The tarball must not contain
`test/`, `node_modules/`, `src/`, or any agent or review artifacts.

Also confirm in `package.json`:

- `name` is `@shimpeiws/gatefold`
- `version` is the intended release version
- `bin.gatefold` points to `./bin/gatefold.js`
- `engines.node` is `>=20`

## 4. Publish dry-run

```text
npm publish --dry-run
```

Must succeed without publishing anything. This validates the package metadata,
the file list, and the bin entry against the real registry client.

## 5. Smoke test the packed artifact

```text
TARBALL=$(npm pack --json | jq -r '.[0].filename')
npm install -g "./$TARBALL"
gatefold --help
gatefold path/to/pfl-export.json --format json
npm uninstall -g @shimpeiws/gatefold
```

## 6. Tag and publish

Only after steps 1–5 pass: tag the release commit and run the real publish
from a clean checkout.
