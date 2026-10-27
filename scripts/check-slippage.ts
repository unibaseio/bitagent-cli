/**
 * sdkSlippage must give, for every whole bps value, a number the bond SDK's
 * `BigInt(slippage * 100)` accepts, applying that bps or one at most 4 away.
 * Run: npx tsx scripts/check-slippage.ts
 */
import assert from "node:assert/strict";
import { sdkSlippage } from "../src/lib/bonding.js";

let moved = 0;
for (let bps = 0; bps <= 10_000; bps++) {
  const { value, bps: applied } = sdkSlippage(bps);
  assert.equal(BigInt(value * 100), BigInt(applied), `bps ${bps}`);
  assert.ok(Math.abs(applied - bps) <= 4, `bps ${bps} moved to ${applied}`);
  if (applied !== bps) moved++;
}
assert.equal(sdkSlippage(50).bps, 50);
assert.throws(() => sdkSlippage(12.5));
assert.throws(() => sdkSlippage(-1));
console.log(`sdkSlippage ok for 0..10000 (${moved} values move to a neighbour)`);
