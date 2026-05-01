## ADDED Requirements

### Requirement: `keni init` produces a successful initial commit even when no git user identity is configured

`keni init` SHALL produce its single initial commit (per the existing "initialises git when needed and produces a single initial commit" requirement) regardless of whether the host environment has `user.name` and `user.email` configured in any git config layer (per-repo, per-user global, per-user XDG, or system). When git's standard resolution chain (`git config user.name` and `git config user.email`, evaluated against the project root) yields a non-empty value for both keys, `keni init` SHALL leave identity resolution to git untouched — the commit's author and committer SHALL be whatever git would normally produce (matching the user's configured identity verbatim, byte-for-byte identical to the pre-change behaviour). When either key returns empty (unset, or set to a whitespace-only value), `keni init` SHALL invoke its single `git commit` subprocess with a per-invocation identity override applied via the four standard environment variables `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` so that the commit is attributed to the documented Keni fallback identity (`Keni <keni@example.invalid>`). The fallback values SHALL be exactly `Keni` for both `*_NAME` variables and exactly `keni@example.invalid` for both `*_EMAIL` variables. The fallback SHALL NOT persist beyond the single subprocess invocation: `keni init` SHALL NOT write to `<repo>/.git/config`, SHALL NOT write to `<home>/.gitconfig`, SHALL NOT write to any `XDG_CONFIG_HOME/git/config`, and SHALL NOT write to any system-level git config (`/etc/gitconfig` or equivalent). The detection of "is identity configured" SHALL use git's own resolution machinery (`git config user.name` / `git config user.email`) so the answer agrees exactly with what git would resolve at commit time. The fallback identity SHALL apply to `keni init`'s own initial commit only; downstream Keni surfaces (engineer-workspace commits in step 09, manual-override flows in step 25, role-runtime commits in any later step) SHALL NOT inherit this fallback automatically — each owning step decides its own identity policy.

#### Scenario: Configured user identity is honoured

- **WHEN** the host has `user.name = "Alice"` and `user.email = "alice@example.com"` configured in `~/.gitconfig` (or equivalently in any git config layer that `git config user.name` / `git config user.email` resolves)
- **AND** `keni init` runs in a fresh empty directory
- **THEN** the command exits with status 0
- **AND** `git log -1 --format='%an <%ae>'` returns `Alice <alice@example.com>`
- **AND** `git log -1 --format='%cn <%ce>'` returns `Alice <alice@example.com>`
- **AND** the commit message starts with `Initialise Keni project`

#### Scenario: Missing user identity falls back to the documented Keni identity

- **WHEN** the host has no `user.name` and no `user.email` configured in any git config layer (verified by `git config user.name` and `git config user.email` both returning empty stdout with exit 1 against the project root)
- **AND** `keni init` runs in a fresh empty directory
- **THEN** the command exits with status 0
- **AND** `git log -1 --format='%an <%ae>'` returns `Keni <keni@example.invalid>`
- **AND** `git log -1 --format='%cn <%ce>'` returns `Keni <keni@example.invalid>`
- **AND** the commit message starts with `Initialise Keni project` (the message text is unchanged from the all-environments default)

#### Scenario: Fallback does not persist any git config

- **WHEN** `keni init` runs in a fresh empty directory on a host with no git identity configured
- **AND** the command completes successfully (the fallback path was used)
- **THEN** `git config --get user.name` against the project root returns empty (exit 1, no stdout)
- **AND** `git config --get user.email` against the project root returns empty (exit 1, no stdout)
- **AND** `<root>/.git/config` does not contain a `[user]` section
- **AND** the host's `~/.gitconfig` (or equivalent global config file) is unchanged from before the run
- **AND** any system-level git config file is unchanged from before the run

#### Scenario: Partially-configured identity falls back rather than producing an inconsistent commit

- **WHEN** the host has `user.name = "Alice"` configured but no `user.email` (or vice versa: email is set but name is not, or one of the two values is whitespace-only)
- **AND** `keni init` runs in a fresh empty directory
- **THEN** the command exits with status 0
- **AND** `git log -1 --format='%an <%ae>'` returns `Keni <keni@example.invalid>` (both fallback values, not a mix of user and fallback)
- **AND** `git config --get user.name` against the project root still returns the originally-configured `Alice` (or whichever partial value was set; the fallback did not write any persistent config)

#### Scenario: Subsequent commits in the project use whatever identity git resolves

- **WHEN** `keni init` ran on a host with no git identity configured (the fallback path produced the initial commit attributed to `Keni <keni@example.invalid>`)
- **AND** the user later runs `git config --global user.email "alice@example.com"` and `git config --global user.name "Alice"`
- **AND** the user makes a subsequent commit in the project (for example, by editing a file and running `git add .` and `git commit -m "second commit"`)
- **THEN** the second commit's author and committer are `Alice <alice@example.com>` (the fallback identity from `keni init` does not leak into subsequent commits)

#### Scenario: Idempotent re-run with the fallback path is still a no-op

- **WHEN** `keni init` ran on a host with no git identity configured (the fallback path produced the initial commit)
- **AND** `keni init` runs again with no intervening filesystem changes
- **THEN** the second run exits with status 0
- **AND** stdout contains the phrase "already initialised"
- **AND** `git log --oneline` shows the same commit list as before the second run (no new commit produced — the idempotency requirement is preserved across both identity-configured and identity-less hosts)
