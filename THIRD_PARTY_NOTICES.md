# Third-Party Dependency Attribution

ClientOps Command source code is licensed under Apache-2.0.
Third-party dependencies retain their respective licenses.

This source snapshot does not vendor installed `node_modules`
packages or compiled native dependency binaries. Dependency
versions are recorded in `pnpm-lock.yaml`.

## caniuse-lite

Browser compatibility data is sourced from
[Can I Use](https://caniuse.com/).

Package: https://github.com/browserslist/caniuse-lite

License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)

This attribution recognizes the upstream compatibility dataset.

## Other reviewed dependencies

- `minimatch`: Blue Oak Model License 1.0.0.
  https://blueoakcouncil.org/license/1.0.0

- `@img/sharp-libvips-linux-x64`: LGPL-3.0-or-later,
  with additional component licenses documented upstream.
  https://github.com/lovell/sharp-libvips

The latter two packages were not present in the production
dependency license inventory for the reviewed Codespaces
installation. This does not establish their absence from
every possible packaged build.

If compiled artifacts, native libraries, or container
images are distributed later, review the licenses and
notices of the actual distributed components separately.

This file does not replace upstream license notices.
