import assert from "node:assert/strict";
import test from "node:test";
import { describeProviderHttpFailure } from "@ccr/core/gateway/upstream/executor.ts";

test("classifies diagnosable auth/billing statuses", () => {
  assert.match(describeProviderHttpFailure(401), /auth/);
  assert.match(describeProviderHttpFailure(402), /billing/);
  assert.match(describeProviderHttpFailure(403), /auth/);
});

test("returns undefined for non-diagnosable statuses (no noise)", () => {
  for (const s of [200, 302, 400, 404, 408, 429, 500, 502, 503]) {
    assert.equal(describeProviderHttpFailure(s), undefined, `status ${s} should not be classified`);
  }
});
