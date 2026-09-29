# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |
| < 1.0 | no |

Security fixes land on the latest 1.x release.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/shimpeiws/gatefold/security/advisories/new)
("Report a vulnerability"). Do not open a public issue for an unpatched
vulnerability.

Include: the affected version, the input or invocation that triggers the
issue, and what the impact is (for example an input that escapes the
16 MiB read bound, the run-directory confinement, or causes the CLI to
read files outside a supplied run directory).

## Scope notes

Gatefold is a read-only evidence tool: it never executes or fetches
anything an input names, and every file and stdin read is bounded.
Reports in scope include path-confinement escapes, unbounded reads or
memory use driven by a single input, crashes on malformed inputs that a
caller could reasonably pipe in, and terminal-unsafe output. Dependency
vulnerabilities are tracked by the CI audit gate.
