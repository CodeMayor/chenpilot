# Lock Fencing Tokens (#1070)

A Redis lock can expire while a slow owner is still working. Without fencing,
that owner may write after a newer holder took the lock. `RedisLockService`
now issues a **fencing token** with every successful acquisition.

- `acquireLock()` runs `SET key value NX PX ttl` and, only if it succeeds,
  `INCR lock:fence:<resource>` in the same Lua script. The result carries
  `fencingToken`. The fence counter never expires, so tokens increase
  monotonically across releases and expiries. A failed acquisition never
  advances the token.
- A token is **current** while it equals the latest token issued for the
  resource. When a newer holder acquires the lock, every older token becomes
  stale, even if the older owner is still running.

## Protecting writes

| API | Guarantee |
|---|---|
| `fencedSet(resource, token, key, value)` | Atomic check-and-write in one Lua script. A stale token never commits. Throws `StaleFencingTokenError`. |
| `runFenced(resource, token, write)` | Checks the token, then calls `write(token)`. Use it for side effects outside Redis, and persist or compare the token in that store where you can. |
| `assertFencingToken` / `isFencingTokenCurrent` / `getCurrentFencingToken` | Building blocks |

An owner whose lock expired may still write while **no newer holder exists**.
Fencing protects against overlap with a newer holder, not against expiry itself.

## Current users

- **Swaps** (`src/Agents/tools/swap.ts`): the trade lock's token is checked
  right before `submitTransaction`. If the lock expired during simulation and
  another trade acquired it, the stale swap is not submitted.

Tests: `src/services/lock/__tests__/redisLockFencing.test.ts`.
