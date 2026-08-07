module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.e2e.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  // `waitFor` (support/poll.ts) triggers the outbox relay directly by default, so most
  // eventual-consistency waits collapse to well under the relay's natural ~1-minute cadence --
  // see support/relay.ts. 180s gives headroom for a couple of accelerated waits in sequence
  // plus settle-window guards. The scenarios that deliberately opt out of acceleration (F1/F2,
  // which are testing the natural cadence itself) or that chain several waits (A7's 4-step
  // lifecycle) set their own longer per-test timeout as the 3rd arg to `it`.
  testTimeout: 180_000,
};
