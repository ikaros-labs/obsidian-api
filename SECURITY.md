# Security policy

Spall's job is to keep each account inside its scope, so any way to read, list, count, search or write something an account wasn't granted is a vulnerability. So is anything that reveals a hidden path's existence beyond the known cases in [api-design.md](api-design.md#known-leaks-by-design).

## Reporting

Please **don't open a public issue**. Report privately through GitHub: **Security → Report a vulnerability** on [ikaros-labs/spall](https://github.com/ikaros-labs/spall/security/advisories/new).

Include the version (or image tag), the relevant part of the config (redact tokens and hashes), the request and what it revealed. You should get a reply within a week. Fixes are released as a patch version and credited in the advisory unless you'd rather not be named.

## Supported versions

Only the latest release gets security fixes.
