module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.e2e.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  // Most scenarios wait for eventual consistency at least once (opening the fixture account,
  // support/testAccount.ts), and several wait a second time after freezing/closing/depositing --
  // each wait bounded at up to 150s under load (support/poll.ts). Give headroom for two such
  // waits in sequence plus settle-window guards; scenarios needing more (e.g. A7's 4-wait
  // lifecycle) set their own longer per-test timeout as the 3rd arg to `it`.
  testTimeout: 420_000,
};
