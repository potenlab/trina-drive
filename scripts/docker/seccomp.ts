#!/usr/bin/env bun
// Writes docker/seccomp-bwrap.json: Docker's default seccomp profile plus the smallest set of rules bubblewrap needs to
// build a worker sandbox inside the container (docs/DOCKER.md, "Security settings"). Regenerate it when Docker's
// default profile changes:
//
//   bun scripts/docker/seccomp.ts            (downloads the pinned upstream profile, checks its SHA-256)
//
// What is added, all with CAP_SYS_ADMIN still dropped in the container:
//   clone, unshare  only together with CLONE_NEWUSER: a process may create namespaces only inside a new user namespace,
//                   where it is root over nothing but its own namespaces (Docker's default allows no namespace flags
//                   without CAP_SYS_ADMIN)
//   mount, umount2, pivot_root
//                   the kernel allows these only in a mount namespace owned by a user namespace the caller created; in
//                   the container's own namespaces they still fail (no CAP_SYS_ADMIN there)
// clone3 keeps Docker's ENOSYS (the C library then falls back to clone, which the filter can inspect).
import fs from 'node:fs'
import path from 'node:path'

// moby/profiles seccomp v0.1.0, vendored by Docker Engine 29.2.1 (github.com/moby/moby, tag docker-v29.2.1)
const UPSTREAM = 'https://raw.githubusercontent.com/moby/moby/docker-v29.2.1/vendor/github.com/moby/profiles/seccomp/default.json'
const UPSTREAM_SHA256 = '01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28'
const CLONE_NEWUSER = 0x10000000

const res = await fetch(UPSTREAM)
if (!res.ok) throw new Error(`${UPSTREAM}: HTTP ${res.status}`)
const text = await res.text()
const sha = new Bun.CryptoHasher('sha256').update(text).digest('hex')
if (sha !== UPSTREAM_SHA256) throw new Error(`${UPSTREAM}: SHA-256 ${sha}, pinned ${UPSTREAM_SHA256}`)
const profile = JSON.parse(text) as { syscalls: unknown[] }
const newUser = (index: number) => [{ index, value: CLONE_NEWUSER, valueTwo: CLONE_NEWUSER, op: 'SCMP_CMP_MASKED_EQ' }]
profile.syscalls.push(
  { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: newUser(0), excludes: { arches: ['s390', 's390x'] }, comment: 'trina-drive: bubblewrap, namespaces only with a new user namespace' },
  { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: newUser(1), includes: { arches: ['s390', 's390x'] }, comment: 'trina-drive: bubblewrap (s390 swaps the clone arguments)' },
  { names: ['unshare'], action: 'SCMP_ACT_ALLOW', args: newUser(0), comment: 'trina-drive: bubblewrap, namespaces only with a new user namespace' },
  { names: ['mount', 'umount2', 'pivot_root'], action: 'SCMP_ACT_ALLOW', comment: 'trina-drive: bubblewrap builds the sandbox root; the kernel refuses these outside a user namespace the caller owns' },
)
const out = path.join(import.meta.dir, '..', '..', 'docker', 'seccomp-bwrap.json')
fs.writeFileSync(out, JSON.stringify(profile, null, 1) + '\n')
console.log(`wrote ${out} (upstream ${sha})`)
