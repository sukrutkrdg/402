// Proxy vitest test runner primitives from globals.
// This resolves the Windows ESM module-caching / runner-init desync where
// importing 'vitest' within a test file resolves a duplicate instance of @vitest/runner
// that lacks the active runner context.

const g = globalThis as any;

export const describe = new Proxy(function () {} as any, {
  apply(_target, thisArg, args) {
    return g.describe.apply(thisArg, args);
  },
  get(_target, prop) {
    return g.describe?.[prop];
  },
});

export const it = new Proxy(function () {} as any, {
  apply(_target, thisArg, args) {
    return g.it.apply(thisArg, args);
  },
  get(_target, prop) {
    return g.it?.[prop];
  },
});

export const test = new Proxy(function () {} as any, {
  apply(_target, thisArg, args) {
    return (g.test || g.it).apply(thisArg, args);
  },
  get(_target, prop) {
    return (g.test || g.it)?.[prop];
  },
});

export const expect = new Proxy(function () {} as any, {
  apply(_target, thisArg, args) {
    return g.expect.apply(thisArg, args);
  },
  get(_target, prop) {
    return g.expect?.[prop];
  },
});

export const vi = new Proxy({} as any, {
  get(_target, prop) {
    return g.vi?.[prop];
  },
});

export const beforeEach = (...args: any[]) => g.beforeEach(...args);
export const afterEach = (...args: any[]) => g.afterEach(...args);
export const beforeAll = (...args: any[]) => g.beforeAll(...args);
export const afterAll = (...args: any[]) => g.afterAll(...args);

export default {
  describe,
  it,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
};
