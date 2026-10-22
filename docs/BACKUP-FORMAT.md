# Backup archive format, version 1

A backup is one file, `<name>-<UTC time>.bkp` (for example `shelf-20261022T031700Z.bkp`), made by
`<name> backup run`. It is encrypted to a public key, so the server can make backups without being able to read
them; only the holder of the matching secret key can verify or restore one. Code: `src/backup/`.

## What is inside

| Logical path | What | Why |
|---|---|---|
| `db/store.db` | SQLite snapshot taken with `VACUUM INTO` (one consistent read transaction while the server keeps running) | people, groups, rules, tokens (hashes), registered folders, drafts index, versions, trash, provenance, the audit hash chain |
| `drafts/<aa>/<sha256>` | every draft version's content (content-addressed) | drafts exist only on this server |

Not inside: the original files of registered folders (the NAS shares; the NAS's own backup covers them), the text
mirror (a cache rebuilt from the originals), logs, `config/` (rewritten by the installer), the backup key, the
first-setup token. The archive says this itself (`excludes` in the info record) and `backup run` prints it.

## Layers

```
file = header (124 bytes) || STREAM of AES-256-GCM chunks
plaintext of the STREAM = inner archive (records)
```

### Header

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | magic `89 42 4B 50 0D 0A 1A 0A` (`\x89BKP\r\n\x1a\n`, catches text-mode transfers) |
| 8 | 1 | format version = `1` |
| 9 | 1 | suite = `1`: X25519, HKDF-SHA256, AES-256-GCM, 64 KiB STREAM |
| 10 | 1 | log2(chunk size) = `16` |
| 11 | 1 | reserved, `0` |
| 12 | 16 | recipient key id = SHA-256(recipient public key)[0..16] |
| 28 | 32 | ephemeral X25519 public key |
| 60 | 16 | payload salt (random) |
| 76 | 48 | wrapped file key: AES-256-GCM(wrap key, nonce = 12 zero bytes, plaintext = 32-byte file key, AAD = header bytes 0..76) = 32 bytes + 16-byte tag |

```
shared      = X25519(ephemeral secret, recipient public)            (decrypt: X25519(recipient secret, ephemeral public))
wrap key    = HKDF-SHA256(ikm = shared, salt = ephemeral public || recipient public, info = "bkp/v1 wrap", 32 bytes)
file key    = 32 random bytes, new for every archive (so the all-zero wrap nonce is used once per key)
payload key = HKDF-SHA256(ikm = file key, salt = payload salt, info = "bkp/v1 payload", 32 bytes)
```

The header's first 76 bytes are the AAD of the key wrap, so changing the version, suite, key id, ephemeral key or salt
makes the file unopenable. A reader that does not know the version or suite stops before trying a key.

### STREAM

The plaintext is cut into 64 KiB chunks; each is sealed with AES-256-GCM under the payload key:

```
nonce(i) = i as 11-byte big-endian counter || last flag (0x01 for the final chunk, else 0x00)
chunk(i) = AES-256-GCM(payload key, nonce(i), plaintext[i*64K .. (i+1)*64K]) = ciphertext || 16-byte tag
```

Every chunk but the last holds exactly 64 KiB; the last holds 1 to 64 KiB (0 only when the whole plaintext is empty).
A reader knows from the file size which chunk is last and opens it with the last flag. So:

- a changed byte anywhere fails one chunk's tag ("tampered");
- a file cut at a chunk boundary ends in a chunk that only opens as "not last" ("truncated");
- a file cut inside a chunk, with bytes appended, or with chunks swapped fails a tag;
- the wrong secret key fails at the key id (a clear "made for key X" message) and, if the key id was forged, at the
  key unwrap.

This is the construction `age` uses (X25519 recipient stanza + ChaCha20-Poly1305 STREAM), with AES-256-GCM because it
is what Bun's built-in crypto offers natively; we do not claim compatibility with `age` files.

### Inner archive

```
"BKPTAR01"
record*  where record = u32 big-endian JSON length (1..65536) || UTF-8 JSON object
         and a "file" record is followed by exactly `size` content bytes and the 32-byte SHA-256 of that content
```

1. First record `{"t":"info","format":1,"product","productVersion","createdAt","host","layout":"installed"|"flat","excludes":[…],"db":{"auditRows","auditHead","drafts","versions"}}`
2. Any number of `{"t":"file","path","size","mode"}`. Paths: `db/store.db`, or `drafts/` + 1-4 segments of
   `[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}`. No path twice.
3. Last record `{"t":"end","files":N,"bytes":B}` matching what came before. Nothing may follow it.

## Keys

```
secret key:  <name>_bksec1_<base64url(32-byte X25519 secret)><6-char checksum>
public key:  <name>_bkpub1_<base64url(32-byte X25519 public)>
checksum  =  base64url(SHA-256("bksec1" || secret))[0..6]   (catches typos when a key is typed back in)
fingerprint = first 8 bytes of the key id in hex, e.g. 0533-b246-e2cd-4573
```

The installer makes a key pair, stores only the public key (`config/backup-recipient`, root-owned) and prints the
secret key once. `backup keygen` makes another (`--set` stores its public key; older archives keep needing the old
secret key).

## What a reader checks (`backup verify`, and `backup restore` before it moves anything into place)

1. Header: magic, version, suite; key id equals the given key's; the file key unwraps.
2. Every chunk authenticates, the last one as last, nothing after it.
3. Records: info first, end last with matching counts, every content hash, allowed paths only, no duplicates.
4. Content: SQLite `PRAGMA integrity_check` is `ok`; the audit row count and head hash equal what the info record
   says; every `draft_versions.sha256` has its `drafts/<aa>/<sha256>` in the archive; a content-addressed draft's
   bytes hash to its name.

Restore writes into a new sibling folder, runs the checks on what it wrote, and only then renames it into place;
on any failure it removes everything it wrote.

## Limits of the design (said plainly)

- Encryption to a public key gives confidentiality and integrity, not authorship: anyone who has the public key can
  make a valid archive. Restore therefore treats archive contents as untrusted (path allow-list, `O_EXCL |
  O_NOFOLLOW` writes, a new empty folder only), and the backup folder should be writable only by the server account.
- An attacker who can replace files in the backup folder can replace a newer archive with an older genuine one.
  Check the date `backup verify` prints.
- `verify` holds the database image in memory (it never writes plaintext to disk); databases of several GB need
  that much free memory.

## Changing the format

A new header version or suite number for any change in the cipher layers, a new inner magic or `format` for the
record layer. Readers refuse what they do not know rather than guess.
