# Third-party software and licenses

Trina Drive itself is licensed under the [Apache License 2.0](../LICENSE) (server, CLI, web app and website); the
required notices are in [NOTICE](../NOTICE). This page lists what we ship or depend on that is not ours, its license,
and whether it is compatible with distributing Trina Drive under Apache-2.0.

Last scan: 2026-10-23, from the `license` field of every installed package in `node_modules/` (root and `website/`),
`bun.lock` as of this commit. Re-run it when dependencies change (see [How to re-scan](#how-to-re-scan)).

## Summary

- **Nothing GPL or AGPL is linked into or bundled with Trina Drive's own code.** All required npm runtime packages are
  MIT, ISC, BSD-2/3-Clause, 0BSD or Apache-2.0.
- **Weak copyleft, optional:** `node-liblzma` (LGPL-3.0), an optional dependency of just-bash. See
  [Notes](#node-liblzma-lgpl-30).
- **GPL tool shipped as a separate program:** poppler's `pdftotext` (GPL-2.0 or GPL-3.0) is bundled in macOS release
  packages and installed from Debian in the Docker image. The server runs it as a separate process; it is not linked.
  This is "mere aggregation" and does not affect Trina Drive's license, but **whoever distributes the release or the
  image must make the corresponding poppler source available**. See [Notes](#poppler-pdftotext-gpl).
- **Build-time only (never shipped):** MPL-2.0 (`lightningcss`, used by Vite and Astro), LGPL-3.0-or-later
  (`@img/sharp-libvips-*`, used by Astro's image service), BlueOak-1.0.0 and CC0-1.0. Fine to use; nothing to do.

## Shipped with Trina Drive

### Our own code adapted from elsewhere

| What | Origin | License |
|---|---|---|
| `src/extract/hwp.ts` (HWP/HWPX text) | adapted from Team AX `server/src/files/hwp.ts`, same owner (Trina Inc.); its SheetJS CFB dependency is replaced by our own `src/extract/cfb.ts` | Apache-2.0 (ours) |
| `docker/seccomp-bwrap.json` | Docker's default seccomp profile, [moby/profiles](https://github.com/moby/profiles) v0.1.0, plus the rules bubblewrap needs (`scripts/docker/seccomp.ts`) | Apache-2.0 (attributed in NOTICE) |
| `docker/apparmor-trina-drive-bwrap` | Docker's `docker-default` AppArmor profile, moby/profiles v0.1.0, plus three rules | Apache-2.0 (attributed in NOTICE) |

### External programs

| Program | License | How it ships | Where its license is |
|---|---|---|---|
| [Bun](https://bun.sh) runtime | MIT; statically links JavaScriptCore/WebKit (LGPL-2.1) and other libraries listed in Bun's own license | macOS release: inside `bin/tdrive` (`bun build --compile`). Docker: `/usr/local/bin/bun` from the pinned `oven/bun` image | [bun.sh/docs/project/licensing](https://bun.sh/docs/project/licensing) |
| [ripgrep](https://github.com/BurntSushi/ripgrep) 15.2.0 (`rg`) | MIT OR Unlicense | official binary, SHA-256 pinned in `scripts/tools.json` | `tools/licenses/ripgrep/` (release), `/usr/share/trina-drive/licenses/ripgrep/` (image) |
| [poppler](https://poppler.freedesktop.org) 26.04.0 (`pdftotext`) and its libraries | GPL-2.0-only OR GPL-3.0-only; its libraries under their own licenses | macOS release: the Homebrew bottle and its library closure in `tools/` (`scripts/build.ts`). Docker: Debian's `poppler-utils` | `tools/licenses/<package>/` (release), `/usr/share/doc/<package>/copyright` (image) |
| Debian packages in the image (bubblewrap, poppler-utils, tini, tzdata, ca-certificates and the base system) | various (mostly GPL/LGPL/MIT/BSD), separate programs | `debian:trixie-slim` base + `apt-get install` | `/usr/share/doc/<package>/copyright`; versions in `/usr/share/trina-drive/packages.txt` and the SBOM |

### Fonts and images

| What | License |
|---|---|
| Geist and Geist Mono (`website/public/fonts/`) | SIL Open Font License 1.1, text kept next to the fonts in `OFL-Geist.txt` |
| Third-party logos (`website/public/logos/`) | trademarks of their owners, used per their brand guidelines; not covered by our license ([website/LOGO-SOURCES.md](../website/LOGO-SOURCES.md)) |

The web app (`web/`) uses system fonts only.

### npm packages: web app bundle

The web app built by Vite (`web/dist`, served by the server) bundles react 19.3.0, react-dom 19.3.0 and
scheduler 0.28.0, all MIT.

### npm packages: server runtime

Direct dependencies: `just-bash` 3.6.0 (Apache-2.0) and `@simplewebauthn/server` 13.3.3 (MIT). Their full runtime
tree (installed with `bun install --production`, shipped in the Docker image's `node_modules/` and compiled into the
macOS binary):

| Package | Version | License |
|---|---|---|
| @borewit/text-codec | 0.2.2 | MIT |
| @hexagon/base64 | 1.1.28 | MIT |
| @levischuck/tiny-cbor | 0.2.11 | MIT |
| @mixmark-io/domino | 2.2.0 | BSD-2-Clause |
| @nodable/entities | 3.1.0 | MIT |
| @peculiar/asn1-android | 2.11.0 | MIT |
| @peculiar/asn1-cms | 2.11.0 | MIT |
| @peculiar/asn1-csr | 2.11.0 | MIT |
| @peculiar/asn1-ecc | 2.11.0 | MIT |
| @peculiar/asn1-pfx | 2.11.0 | MIT |
| @peculiar/asn1-pkcs8 | 2.11.0 | MIT |
| @peculiar/asn1-pkcs9 | 2.11.0 | MIT |
| @peculiar/asn1-rsa | 2.11.0 | MIT |
| @peculiar/asn1-schema | 2.11.0 | MIT |
| @peculiar/asn1-x509-attr | 2.11.0 | MIT |
| @peculiar/asn1-x509 | 2.11.0 | MIT |
| @peculiar/utils | 2.0.3 | MIT |
| @peculiar/x509 | 1.14.3 | MIT |
| @simplewebauthn/server | 13.3.3 | MIT |
| @tokenizer/inflate | 0.4.1 | MIT |
| @tokenizer/token | 0.3.0 | MIT |
| anynum | 1.0.1 | MIT |
| asn1js | 3.1.0 | BSD-3-Clause |
| commander | 6.2.1 | MIT |
| debug | 4.4.3 | MIT |
| diff | 8.0.4 | BSD-3-Clause |
| fast-xml-builder | 1.3.1 | MIT |
| fast-xml-parser | 5.11.2 | MIT |
| file-type | 21.3.4 | MIT |
| guarded-fetch | 0.1.3 | Apache-2.0 |
| ieee754 | 1.2.1 | BSD-3-Clause |
| ini | 6.0.0 | ISC |
| ipaddr.js | 2.2.0 | MIT |
| is-unsafe | 2.0.2 | MIT |
| just-bash | 3.6.0 | Apache-2.0 |
| modern-tar | 0.7.7 | MIT |
| ms | 2.1.3 | MIT |
| papaparse | 5.7.0 | MIT |
| path-expression-matcher | 1.6.2 | MIT |
| pvtsutils | 1.3.6 | MIT |
| pvutils | 1.2.0 | MIT |
| re2js | 1.4.0 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| run | 2.1.3 | Apache-2.0 |
| seek-bzip | 2.0.0 | MIT |
| smol-toml | 1.9.1 | BSD-3-Clause |
| sprintf-js | 1.1.3 | BSD-3-Clause |
| sql.js | 1.15.1 | MIT |
| strnum | 2.5.1 | MIT |
| strtok3 | 10.6.2 | MIT |
| token-types | 6.1.2 | MIT |
| tslib | 1.14.1 | 0BSD |
| tslib | 2.8.1 | 0BSD |
| tsyringe | 4.10.0 | MIT |
| turndown | 7.2.4 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| uint8array-extras | 1.6.0 | MIT |
| undici | 7.29.0 | MIT |
| xml-naming | 0.3.0 | MIT |
| yaml | 2.9.1 | ISC |

Optional dependencies of just-bash (native compression add-ons and their install tooling). They are installed but
**never built**: Bun runs no install scripts of untrusted dependencies and the Dockerfile adds `--ignore-scripts`, so no
native add-on is compiled and just-bash goes without them.

| Package | Version | License |
|---|---|---|
| @mongodb-js/zstd | 7.0.0 | Apache-2.0 |
| base64-js | 1.5.1 | MIT |
| bl | 4.1.0 | MIT |
| buffer | 5.7.1 | MIT |
| chownr | 1.1.4 | ISC |
| decompress-response | 6.0.0 | MIT |
| deep-extend | 0.6.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| end-of-stream | 1.4.5 | MIT |
| expand-template | 2.0.3 | (MIT OR WTFPL) |
| fs-constants | 1.0.0 | MIT |
| github-from-package | 0.0.0 | MIT |
| inherits | 2.0.4 | ISC |
| ini | 1.3.8 | ISC |
| mimic-response | 3.1.0 | MIT |
| minimist | 1.2.8 | MIT |
| mkdirp-classic | 0.5.3 | MIT |
| napi-build-utils | 2.0.0 | MIT |
| node-abi | 3.100.0 | MIT |
| node-addon-api | 8.9.2 | MIT |
| node-gyp-build | 4.8.4 | MIT |
| node-liblzma | 2.2.0 | LGPL-3.0 |
| once | 1.4.0 | ISC |
| prebuild-install | 7.1.3 | MIT |
| pump | 3.0.4 | MIT |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| readable-stream | 3.6.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| semver | 7.8.5 | ISC |
| simple-concat | 1.0.1 | MIT |
| simple-get | 4.0.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| strip-json-comments | 2.0.1 | MIT |
| tar-fs | 2.1.5 | MIT |
| tar-stream | 2.2.0 | MIT |
| tunnel-agent | 0.6.0 | Apache-2.0 |
| util-deprecate | 1.0.2 | MIT |
| wrappy | 1.0.2 | ISC |

## Development and build only (not shipped)

| Tree | Packages | Licenses |
|---|---|---|
| root `devDependencies` (typescript, @types/*, vite, @vitejs/plugin-react, @modelcontextprotocol/sdk for tests) | 119 | MIT 102, ISC 8, BSD-3-Clause 3, Apache-2.0 3, MPL-2.0 2 (`lightningcss`), BSD-2-Clause 1 |
| `website/` (astro and its tree; the output is static files) | 185 | MIT 152, ISC 9, BSD-2-Clause 8, Apache-2.0 5, BSD-3-Clause 3, BlueOak-1.0.0 3, MPL-2.0 2 (`lightningcss`), CC0-1.0 2, LGPL-3.0-or-later 1 (`@img/sharp-libvips-darwin-arm64`, a prebuilt libvips loaded by sharp at build time) |

MPL-2.0 and LGPL at build time impose nothing on our code or on the generated site.

## Notes

### node-liblzma (LGPL-3.0)

An optional dependency of just-bash for `xz`/`lzma` in the agent shell. LGPL-3.0 allows use from Apache-2.0 code as
long as the library stays replaceable and its source is available. In our builds it is present only as its npm
package (JavaScript, C sources and `binding.gyp`, which is its source) and is never compiled, so it is inert. If you
ever build it (drop `--ignore-scripts`), ship its LICENSE with it and keep it a separate, replaceable shared object,
which is how Node/Bun native add-ons work anyway. To leave it out entirely, install with `--omit=optional`.

### poppler pdftotext (GPL)

Trina Drive calls `pdftotext` as a separate process and reads its output; it does not link poppler. That keeps the
GPL from reaching our code, and our Apache-2.0 license unchanged. Distributing the poppler binaries (in the macOS
release or the Docker image) still carries the GPL's source obligation:

- **macOS release:** attach the source of poppler 26.04.0 and of each GPL/LGPL library in `tools/lib` (the exact
  upstream tarballs the Homebrew bottles were built from, plus Homebrew's patches, if any) to the GitHub Release, or
  link to them from the release notes. *Action item before the first public release.*
- **Docker image:** Debian's source packages for the exact versions in `/usr/share/trina-drive/packages.txt` are on
  [snapshot.debian.org](https://snapshot.debian.org); link it from the image's release notes.

### Bun (LGPL-2.1 parts)

Bun statically links JavaScriptCore/WebKit (LGPL-2.1). The LGPL lets a statically linked program ship as long as
users can relink it with a modified library. Trina Drive is open source, so anyone can rebuild `bin/tdrive` with a
modified Bun (`bun scripts/build.ts`); Bun's patched WebKit is public at
[github.com/oven-sh/WebKit](https://github.com/oven-sh/WebKit).

## How to re-scan

```sh
bun install && (cd website && bun install)
bunx license-checker --summary --production          # server runtime tree
bunx license-checker --summary --start website       # website (build only)
```

Anything new under GPL, AGPL, SSPL, BUSL, "Commons Clause" or no license must not become a runtime dependency; raise
it in the pull request.
