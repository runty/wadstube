import test from "node:test";
import assert from "node:assert/strict";
import { focusReturnTarget, isUsableFocusTarget } from "../src/stores/modal.js";

function target(overrides = {}) {
  return {
    isConnected: true,
    disabled: false,
    hidden: false,
    tabIndex: 0,
    inert: false,
    closest: () => null,
    getClientRects: () => [{}],
    ...overrides,
  };
}

test("modal focus targets exclude detached, disabled, hidden, inert, and negative-tabindex nodes", () => {
  assert.equal(isUsableFocusTarget(target()), true);
  assert.equal(isUsableFocusTarget(target({ isConnected: false })), false);
  assert.equal(isUsableFocusTarget(target({ disabled: true })), false);
  assert.equal(isUsableFocusTarget(target({ hidden: true })), false);
  assert.equal(isUsableFocusTarget(target({ inert: true })), false);
  assert.equal(isUsableFocusTarget(target({ tabIndex: -1 })), false);
  assert.equal(isUsableFocusTarget(target({ getClientRects: () => [] })), false);
  const fallback = target();
  assert.equal(focusReturnTarget(target({ isConnected: false }), fallback), fallback);
});
